import * as THREE from 'three';
import type { HUD } from './hud';
import type { Mode, Player } from './player';
import { num, t } from './i18n';
import { distanceText, setDistance } from './pois';
import { LOW } from './quality';
import { sfx } from './sfx';
import type { World } from './world';

/**
 * Game modes: timed challenges played on points from open data, baked by
 * pipeline/build_games.py into data/games/.
 *
 * Every mode is the same loop - targets near where the player stands, a
 * beacon over each, a compass to the nearest, a clock - plus its own rule:
 * a sleigh that never lands, a body heating up in the sun, a watering can
 * that runs dry, a bladder, a waistline. Targets are picked around the
 * player's position when the game starts, so a game can be played anywhere
 * in the built city: roam somewhere, press P, play there.
 *
 * On top of each rule sits the same arcade layer, Crazy Taxi style: targets
 * are worth points, reaching the next one quickly builds a combo that
 * multiplies them, most modes give a few seconds back for each target, and
 * a few targets are golden. The best score on the course is chased live, and
 * medals mark how far a run got.
 */

/** The modes; their texts are in i18n.ts under mode.<id>.* */
export interface ModeInfo {
  id: string;
  emoji: string;
}

export const MODE_INFO: ModeInfo[] = [
  { id: 'markets', emoji: '🎅' },
  { id: 'heat', emoji: '🥵' },
  { id: 'giessen', emoji: '🌱' },
  { id: 'toilets', emoji: '🚻' },
  { id: 'doener', emoji: '🥙' },
];

/**
 * Round lengths, seconds. Short on purpose: a casual round is about a
 * minute or two, and the fun is in going again. The texts take theirs from
 * here as {dur}.
 */
export const LIMITS: Record<string, number> = {
  markets: 90, heat: 90, giessen: 90, toilets: 120, doener: 60,
};
/** Klo-Notstand: how many toilets make a win. */
const TOILET_GOAL = 5;

/** "90 seconds", "2 minutes", in the current language. */
function duration(s: number): string {
  return s % 60 === 0 && s >= 120 ? t('dur.m', { n: s / 60 }) : t('dur.s', { n: s });
}

/** A mode's text in the current language: title, blurb, controls, source, unit. */
export function modeText(id: string, what: string, vars: Record<string, string | number> = {}): string {
  return t(`mode.${id}.${what}`, { dur: duration(LIMITS[id] ?? 90), goal: TOILET_GOAL, ...vars });
}

/** What a mode says about how it went; the last line is its data source. */
export interface Outcome {
  won: boolean;
  title: string;
  lines: string[];
}

export interface Result extends Outcome {
  /** Points. */
  score: number;
  /** Targets reached. */
  count: number;
  /** 0 for none, 1-3 for bronze to gold. */
  medal: number;
  combo: number;
  golds: number;
}

export interface GameHost {
  scene: THREE.Scene;
  world: World;
  player: Player;
  hud: HUD;
  camera: THREE.PerspectiveCamera;
  setNight(n: number): void;
}

/**
 * Games run faster than free roam: targets lie hundreds of metres apart, and
 * a minute of jogging to the first one is no fun. Walking, riding and the
 * sleigh speed up by this; the car is fast enough as it is.
 */
const GAME_PACE = 1.6;

/** Points for a target, before the combo multiplier. */
const BASE = 100;
/** The combo multiplier stops growing here. */
const MAX_MULT = 5;
/** A golden target is worth this many times the points, and twice the time. */
const GOLD_MULT = 3;
const GOLD_COLOUR = '#ffd23f';
export const MEDALS = ['🥉', '🥈', '🥇'];

/**
 * Is the target at (x, z) golden? A hash of where it is, not a dice roll,
 * so everyone on a course sees the same golden targets and scores compare.
 * About one in fourteen.
 */
function isGold(x: number, z: number): boolean {
  let h = Math.imul(Math.round(x) | 0, 73856093) ^ Math.imul(Math.round(z) | 0, 19349663);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) % 100 < 7;
}

interface Spot {
  x: number;
  z: number;
  n: string;
  d: string;
  kind: string;
  done: boolean;
  /** How close counts as there; widened once the ground is known. */
  reach: number;
  snapped: boolean;
  need: number;
  got: number;
  gold: boolean;
}

type RawPoint = [number, number, string, string, string?];

const DATA = 'data/games/';

async function points(file: string): Promise<{ points: RawPoint[]; attribution: string }> {
  const res = await fetch(DATA + file);
  if (!res.ok) throw new Error(`${file} missing - run pipeline/build_games.py`);
  return res.json();
}

function spot(p: RawPoint, reach: number, kind = p[4] ?? ''): Spot {
  return { x: p[0], z: p[1], n: p[2], d: p[3], kind, done: false, reach,
           snapped: false, need: 0, got: 0, gold: kind !== 'pump' && isGold(p[0], p[1]) };
}

/* --- beacons --------------------------------------------------------------- */

const iconCache = new Map<string, THREE.Texture>();

function icon(emoji: string, colour: string): THREE.Texture {
  const key = emoji + colour;
  let t = iconCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = colour;
  g.beginPath();
  g.arc(64, 58, 50, 0, Math.PI * 2);
  g.fill();
  // a pointer under the disc, like a map pin
  g.beginPath();
  g.moveTo(44, 96); g.lineTo(84, 96); g.lineTo(64, 124); g.closePath();
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(255,255,255,.9)';
  g.beginPath();
  g.arc(64, 58, 50, 0, Math.PI * 2);
  g.stroke();
  g.font = '60px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji, 64, 62);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  iconCache.set(key, t);
  return t;
}

const COLUMN = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0);

/** A pin over the target and a column of light up into the sky, with how far
 *  it is underneath. Pins keep their size on screen and show through
 *  buildings: they are the objective. A golden one is bigger and wobbles. */
class Beacon {
  readonly group = new THREE.Group();
  private readonly pin: THREE.Sprite;
  private readonly column: THREE.Mesh;
  private readonly dist: THREE.Sprite;
  private readonly pinHeight: number;

  constructor(emoji: string, colour: string, height: number, width: number, private readonly gold: boolean) {
    if (gold) width *= 1.8;
    this.pin = new THREE.Sprite(new THREE.SpriteMaterial({
      map: icon(emoji, colour), depthTest: false, depthWrite: false,
      transparent: true, sizeAttenuation: false,
    }));
    this.pin.renderOrder = 30;
    this.pin.center.set(0.5, 0);
    this.column = new THREE.Mesh(COLUMN, new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: 0.28, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    }));
    this.column.scale.set(width, height, width);
    this.dist = new THREE.Sprite(new THREE.SpriteMaterial({
      depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false,
    }));
    this.dist.renderOrder = 30;
    this.dist.center.set(0.5, 1);
    this.group.add(this.column, this.pin, this.dist);
    this.pinHeight = Math.min(height, 6);
  }

  set(emoji: string, colour: string): void {
    (this.pin.material as THREE.SpriteMaterial).map = icon(emoji, colour);
    (this.column.material as THREE.MeshBasicMaterial).color.set(colour);
  }

  update(t: number, near: boolean, dist: number): void {
    const s = (near ? 0.075 : 0.05) * (dist < 30 ? 0.8 : 1) * (this.gold ? 1.35 : 1);
    this.pin.scale.set(s, s, 1);
    this.pin.position.y = this.pinHeight + Math.sin(t * 2.4) * 0.4;
    this.pin.material.rotation = this.gold ? Math.sin(t * 5) * 0.18 : 0;
    // the plate hangs under the pin, at about the pin's own scale
    setDistance(this.dist, dist, s * 0.0085);
    this.dist.position.y = this.pin.position.y;
    // the column fades as you arrive, so it doesn't fill the screen
    (this.column.material as THREE.MeshBasicMaterial).opacity =
      Math.min(this.gold ? 0.5 : 0.32, dist / 160);
  }

  dispose(): void {
    (this.pin.material as THREE.Material).dispose();
    (this.column.material as THREE.Material).dispose();
    // the distance plates are shared; only this sprite's material goes
    this.dist.material.dispose();
  }
}

/* --- effects ---------------------------------------------------------------- */

interface Particle { obj: THREE.Object3D; v: THREE.Vector3; life: number; spin: number }
interface Ring { mesh: THREE.Mesh; life: number }

/** A shock ring flat on the ground, where a target was reached. */
const RING = new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2);
const RING_LIFE = 0.8;

/** Falling snow in a box that travels with the camera. */
class Snow {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  /** Moved on the CPU every frame: a phone (quality.ts) gets fewer. */
  private static readonly N = LOW ? 1500 : 5000;
  private static readonly R = 120;

  constructor() {
    this.pos = new Float32Array(Snow.N * 3);
    for (let i = 0; i < this.pos.length; i++) this.pos[i] = (Math.random() * 2 - 1) * Snow.R;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    // a soft round flake rather than the default square
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      map: new THREE.CanvasTexture(c), size: 0.7, transparent: true, opacity: 0.9, depthWrite: false,
    }));
    this.points.frustumCulled = false;
  }

  update(dt: number, at: THREE.Vector3): void {
    const R = Snow.R, p = this.pos;
    for (let i = 0; i < p.length; i += 3) {
      p[i + 1] -= dt * (2.2 + (i % 7) * 0.25);
      p[i] += Math.sin(p[i + 1] * 0.1 + i) * dt * 0.6;
      if (p[i + 1] < -R) p[i + 1] += 2 * R;
    }
    // flakes live in the box's own frame, so moving it is all it takes
    this.points.position.copy(at);
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}

/* --- the shared game loop ---------------------------------------------------- */

const fmt = (s: number) => {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

function el(id: string): HTMLElement {
  return document.getElementById(id)!;
}

/*
 * The panel is redrawn every frame, but most of it changes a few times a
 * second at most. Writing it anyway made a phone restyle and relayout the
 * page every frame (scripts/games-bench.ts), so only what changed is written.
 */
const written = new WeakMap<HTMLElement, Map<string, string>>();
function changed(e: HTMLElement, key: string, value: string): boolean {
  let m = written.get(e);
  if (!m) { m = new Map(); written.set(e, m); }
  if (m.get(key) === value) return false;
  m.set(key, value);
  return true;
}
function put(e: HTMLElement, text: string, html = false): void {
  if (!changed(e, html ? 'html' : 'text', text)) return;
  if (html) e.innerHTML = text; else e.textContent = text;
}
function css(e: HTMLElement, prop: string, value: string): void {
  if (changed(e, prop, value)) e.style.setProperty(prop, value);
}

export abstract class Game {
  readonly info: ModeInfo;
  protected readonly host: GameHost;
  protected spots: Spot[] = [];
  /** Points, combo and gold included. */
  protected score = 0;
  /** Targets reached. */
  protected count = 0;
  protected time = 0;
  protected limit: number;
  /** Movement modes the game allows; null for all. */
  readonly modes: Mode[] | null = null;
  state: 'countdown' | 'play' | 'over' = 'countdown';
  result: Result | null = null;
  /** The best score on this course, set by main.ts, to chase while playing. */
  best: number | null = null;
  protected attribution = '';

  /** Seconds the combo lasts after a target; the next one inside it builds it. */
  protected comboWindow = 15;
  /** Seconds a target puts back on the clock, shrinking over a run; 0 for none. */
  protected timeBonus = 0;
  /** Targets for 🥉 🥈 🥇, or null where the mode awards medals itself. */
  protected medals: [number, number, number] | null = null;
  /** The mode's own speed factor on top of GAME_PACE: a Döner boost, a full bladder. */
  protected pace = 1;

  protected combo = 0;
  private comboLeft = 0;
  private maxCombo = 0;
  private golds = 0;
  private beaten = false;
  private countdown = 3.4;
  private lastCount = 4;
  private lastSec = 0;
  private readonly beacons = new Map<Spot, Beacon>();
  private readonly group = new THREE.Group();
  private remount = 0;
  private bannerTimer = 0;
  private readonly particles: Particle[] = [];
  private readonly rings: Ring[] = [];
  private fov0 = 0;
  private kick = 0;
  private rushMix = 0;
  private beat = 0;
  protected meter: { value: number; label: string; colour: string } | null = null;

  constructor(info: ModeInfo, host: GameHost) {
    this.info = info;
    this.host = host;
    this.limit = LIMITS[info.id] ?? 90;
    host.scene.add(this.group);
  }

  /** Everything the mode could be played on, filled by load(). */
  protected pool: Spot[] = [];
  /** A start is fair when at least `min` targets lie within `r` of it. */
  protected startRule = { r: 1500, min: 6 };
  /** Targets are the pool's nearest `max` within `r` of the start. */
  protected pickRule = { r: 5000, max: 300 };

  /** Fetch the data into the pool. */
  abstract load(): Promise<void>;

  /** Where a start may be anchored: targets of the mode, by default. */
  protected anchors(): Spot[] { return this.pool; }

  /** What makes a start good: enough of these around it. */
  protected density(): Spot[] { return this.pool; }

  /**
   * The start for a seed: one of the anchors with enough targets around
   * it, chosen by the seed, then a seeded 250 m off it so the first target
   * is not under your feet. The same seed and data give the same start,
   * which is what makes scores comparable. Null where no anchor qualifies
   * (a single-area build is too small for most modes).
   */
  choose(seed: number): [number, number] | null {
    const w = this.host.world;
    const { r, min } = this.startRule;
    const grid = new Map<string, Spot[]>();
    const cell = (x: number, z: number) => `${Math.floor(x / r)},${Math.floor(z / r)}`;
    for (const s of this.density()) {
      const k = cell(s.x, s.z);
      const list = grid.get(k);
      if (list) list.push(s); else grid.set(k, [s]);
    }
    const around = (a: Spot) => {
      let n = 0;
      const cx = Math.floor(a.x / r), cz = Math.floor(a.z / r);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const s of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          if ((s.x - a.x) ** 2 + (s.z - a.z) ** 2 < r * r) n++;
        }
      }
      return n;
    };
    const good = this.anchors().filter((a) => w.covers(a.x, a.z) && around(a) >= min);
    if (!good.length) return null;
    const rnd = mulberry32(seed);
    const a = good[Math.floor(rnd() * good.length)];
    const th = rnd() * Math.PI * 2;
    const x = a.x + Math.cos(th) * 250, z = a.z + Math.sin(th) * 250;
    return w.covers(x, z) ? [x, z] : [a.x, a.z];
  }

  /** Pick the targets around wherever the player now is. */
  prepare(): void {
    this.spots = this.pick(this.pool, this.pickRule.r, this.pickRule.max);
  }
  /** The mode's own rule, every frame while playing. */
  protected tick(_dt: number): void {}
  /** A target has been reached. */
  protected abstract reached(s: Spot): void;
  /** The text under the points. */
  protected abstract scoreLine(): string;
  /** Called once when the game ends; may add a closing bonus to the score. */
  protected abstract finish(timeUp: boolean): Outcome;

  /** Emoji and colour of a target's pin. */
  protected abstract look(s: Spot): [string, string];
  /** How much speed rush to show, 0 to 1: wider view, speed lines. */
  protected rush(): number { return 0; }
  /** How urgent things are, 0 to 1; past a half, a heartbeat. */
  protected urgency(): number { return 0; }
  /** How many beacons, how far out; a mode with dense targets shows fewer. */
  protected beaconRange = 1600;
  protected beaconCount = 18;
  protected beaconHeight = 70;
  protected beaconWidth = 1.6;

  /** Targets in the built city, nearest first, at most `max` within `r`. */
  protected pick(raw: Spot[], r: number, max: number): Spot[] {
    const { x, z } = this.host.player.pos;
    return raw
      .filter((s) => this.host.world.covers(s.x, s.z) && Math.hypot(s.x - x, s.z - z) < r)
      .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))
      .slice(0, max);
  }

  start(): void {
    const p = this.host.player;
    p.canFly = false;
    if (p.flying) p.toggleFly();
    if (this.modes && !this.modes.includes(p.mode)) p.setMode(this.modes[0]);
    this.fov0 = this.host.camera.fov;
    el('game').classList.add('on');
    el('gTitle').textContent = `${this.info.emoji} ${this.text('title')}`;
    this.banner(this.best ? t('game.chase', { n: num(this.best, 0) }) : this.text('controls'), 4);
    this.render(this.next());
  }

  /** Leave the world as free roam found it. */
  stop(): void {
    const p = this.host.player;
    p.canFly = true;
    p.speedScale = 1;
    for (const b of this.beacons.values()) b.dispose();
    this.beacons.clear();
    for (const q of this.particles) this.group.remove(q.obj);
    for (const r of this.rings) (r.mesh.material as THREE.Material).dispose();
    this.host.scene.remove(this.group);
    const cam = this.host.camera;
    if (this.fov0) { cam.fov = this.fov0; cam.updateProjectionMatrix(); }
    el('game').classList.remove('on');
    el('count').classList.remove('on');
    el('banner').classList.remove('on');
    css(el('rush'), 'display', 'none');
    el('pops').replaceChildren();
    this.host.hud.marks = [];
  }

  /** One line for the pause screen: time left and points. */
  status(): string {
    return t('pause.info', { time: fmt(this.limit - this.time), n: num(this.score, 0) });
  }

  /** This mode's own strings. */
  protected text(what: string, vars: Record<string, string | number> = {}): string {
    return modeText(this.info.id, what, vars);
  }

  allows(mode: Mode): boolean {
    return !this.modes || this.modes.includes(mode);
  }

  /** The nearest target still to do, for the compass. */
  protected next(): Spot | null {
    const { x, z } = this.host.player.pos;
    let best: Spot | null = null, bd = Infinity;
    for (const s of this.spots) {
      if (s.done || !this.wanted(s)) continue;
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /** Is this target worth pointing at right now? */
  protected wanted(_s: Spot): boolean { return true; }

  protected banner(text: string, seconds = 2.2): void {
    const b = el('banner');
    b.textContent = text;
    b.classList.add('on');
    this.bannerTimer = seconds;
  }

  /** Text that jumps up from the middle of the screen and fades. */
  protected popup(text: string, cls = '', delay = 0): void {
    const p = document.createElement('div');
    p.className = `pop ${cls}`;
    p.textContent = text;
    p.style.animationDelay = `${delay}s`;
    p.addEventListener('animationend', () => p.remove());
    el('pops').append(p);
  }

  /** A flash over the whole screen. */
  private flash(cls = ''): void {
    const f = el('flash');
    f.className = '';
    void f.offsetWidth;   // restart the animation
    f.className = `on ${cls}`;
  }

  /**
   * Score a target: points times the combo, more for gold, time back on
   * the clock, and every bit of noise that makes it feel like it. (x, y, z)
   * is where the effects go off. Returns the points.
   */
  protected award(s: Spot, x = s.x, y = this.host.world.height(s.x, s.z), z = s.z): number {
    this.count++;
    this.combo = this.comboLeft > 0 ? this.combo + 1 : 1;
    this.comboLeft = this.comboWindow;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const mult = Math.min(MAX_MULT, this.combo);
    const pts = BASE * mult * (s.gold ? GOLD_MULT : 1);
    this.score += pts;
    this.popup(`+${num(pts, 0)}`, s.gold ? 'gold big' : 'big');
    if (mult > 1) {
      this.popup(t('game.combo', { n: mult }), 'combo', 0.08);
      sfx.combo(mult);
    }
    if (this.timeBonus) {
      const secs = Math.max(1, Math.round(this.timeBonus * Math.max(0.4, 1 - this.count * 0.04)
                                           * (s.gold ? 2 : 1)));
      this.limit += secs;
      this.popup(t('game.time', { n: secs }), 'time', 0.16);
      const clock = el('gTime');
      clock.classList.remove('plus');
      void clock.offsetWidth;
      clock.classList.add('plus');
    }
    if (s.gold) {
      this.golds++;
      sfx.gold();
      this.popup(t('game.gold', { n: GOLD_MULT }), 'gold', 0.24);
      this.burst(x, y + 1, z, [0xffd23f, 0xfff3b0, 0xffb454], 22, 0.3);
    }
    if (this.medals) {
      const m = this.medals.indexOf(this.count);
      if (m >= 0) {
        this.popup(t('game.medal', { m: MEDALS[m] }), 'gold', 0.4);
        sfx.medal();
      }
    }
    this.ring(x, y, z, s.gold ? GOLD_COLOUR : this.look(s)[1]);
    this.kick = s.gold ? 11 : 6;
    this.flash(s.gold ? 'gold' : '');
    this.checkRecord();
    return pts;
  }

  /** Passed the course's best? Say so, once. */
  private checkRecord(): void {
    if (this.beaten || !this.best || this.score <= this.best) return;
    this.beaten = true;
    this.popup(t('game.record'), 'record', 0.3);
    sfx.record();
    this.flash('gold');
  }

  /** Points added outside award(): a closing bonus. */
  protected bonus(pts: number): void {
    this.score += pts;
    this.checkRecord();
  }

  /** A burst of little objects flying up from (x, y, z). */
  protected burst(x: number, y: number, z: number, colours: number[], n = 14, size = 0.35): void {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size),
                               new THREE.MeshBasicMaterial({ color: colours[i % colours.length] }));
      m.position.set(x, y, z);
      this.group.add(m);
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 5;
      this.particles.push({ obj: m, v: new THREE.Vector3(Math.cos(a) * sp, 6 + Math.random() * 6, Math.sin(a) * sp),
                            life: 1.6 + Math.random(), spin: Math.random() * 8 });
    }
  }

  private ring(x: number, y: number, z: number, colour: string): void {
    const m = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: 0.9, depthWrite: false,
      side: THREE.DoubleSide, fog: false, blending: THREE.AdditiveBlending,
    }));
    m.position.set(x, y + 0.4, z);
    this.group.add(m);
    this.rings.push({ mesh: m, life: 0 });
  }

  /** Called every frame by main.ts. */
  update(dt: number): void {
    const p = this.host.player;
    this.time += this.state === 'play' ? dt : 0;
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.4);
      const c = el('count');
      if (n !== this.lastCount) {
        this.lastCount = n;
        c.textContent = n > 0 ? String(n) : t('game.go');
        c.classList.add('on');
        if (n > 0) sfx.tick(); else sfx.go();
      }
      if (this.countdown <= 0) {
        this.state = 'play';
        c.classList.remove('on');
      }
    } else if (this.state === 'play') {
      this.tick(dt);
      p.speedScale = (p.inCar ? 1 : GAME_PACE) * this.pace;
      for (const s of this.spots) {
        if (s.done) continue;
        const d = Math.hypot(s.x - p.pos.x, s.z - p.pos.z);
        if (d < s.reach && this.inReach(s)) this.reached(s);
      }
      if (this.comboLeft > 0) {
        this.comboLeft -= dt;
        if (this.comboLeft <= 0) {
          if (this.combo >= 2) {
            this.popup(t('game.comboEnd'), 'dim');
            sfx.comboLost();
          }
          this.combo = 0;
        }
      }
      // the last ten seconds count themselves down
      const sec = Math.ceil(this.limit - this.time);
      if (sec !== this.lastSec && sec <= 10 && sec > 0) sfx.tick(sec <= 3);
      this.lastSec = sec;
      const u = this.urgency();
      this.beat -= dt;
      if (u > 0.5 && this.beat <= 0) {
        sfx.heartbeat();
        this.beat = 1.2 - u * 0.6;
      }
      if (this.time >= this.limit && this.state === 'play') this.end(true);
    }

    this.remount -= dt;
    if (this.remount <= 0) {
      this.remount = 0.3;
      this.mountBeacons();
    }
    const nxt = this.next();
    const now = performance.now() / 1000;
    for (const [s, b] of this.beacons) {
      b.update(now, s === nxt, Math.hypot(s.x - p.pos.x, s.z - p.pos.z));
    }
    this.updateParticles(dt);
    this.updateView(dt);
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) el('banner').classList.remove('on');
    }
    this.render(nxt);
  }

  /** The camera kick on a hit and the widening rush of speed. */
  private updateView(dt: number): void {
    const cam = this.host.camera;
    this.kick *= Math.exp(-dt * 4);
    const rush = this.state === 'play' ? this.rush() : 0;
    this.rushMix += (rush - this.rushMix) * Math.min(1, dt * 3);
    const want = this.fov0 + this.kick + this.rushMix * 10;
    if (Math.abs(cam.fov - want) > 0.01) {
      cam.fov = want;
      cam.updateProjectionMatrix();
    }
    // a full-screen animation costs even when invisible, so it is taken out then
    const lines = el('rush');
    css(lines, 'opacity', String(Math.round(this.rushMix * 70) / 100));
    css(lines, 'display', this.rushMix > 0.01 ? 'block' : 'none');
  }

  /** Any extra condition on top of distance, e.g. the sleigh's altitude. */
  protected inReach(_s: Spot): boolean { return true; }

  /** 0 to 3: which medal the run has earned. */
  protected medal(): number {
    return this.medals ? this.medals.filter((m) => this.count >= m).length : 0;
  }

  protected end(timeUp: boolean): void {
    if (this.state === 'over') return;
    this.state = 'over';
    const outcome = this.finish(timeUp);
    this.result = { ...outcome, score: this.score, count: this.count, medal: this.medal(),
                    combo: this.maxCombo, golds: this.golds };
    if (this.result.won) sfx.win(); else sfx.lose();
  }

  private mountBeacons(): void {
    const { x, z } = this.host.player.pos;
    const w = this.host.world;
    const near = this.spots
      .filter((s) => !s.done && this.wanted(s))
      .map((s) => [Math.hypot(s.x - x, s.z - z), s] as const)
      .filter(([d]) => d < this.beaconRange)
      .sort((a, b) => a[0] - b[0])
      .slice(0, this.beaconCount);
    const keep = new Set(near.map(([, s]) => s));
    for (const [s, b] of [...this.beacons]) {
      if (keep.has(s)) continue;
      this.group.remove(b.group);
      b.dispose();
      this.beacons.delete(s);
    }
    for (const [d, s] of near) {
      // Points are where the data puts them - a kebab shop's node is inside
      // its building. Once the ground there is loaded, widen the reach by
      // how far the nearest walkable spot is, so every target can be reached.
      if (!s.snapped && d < 300 && w.tileAt(s.x, s.z)?.level === 'full') {
        const at = w.nav.nearestPassable(s.x, s.z, false, 40);
        s.reach += at ? Math.hypot(at[0] - s.x, at[1] - s.z) : 30;
        s.snapped = true;
      }
      const [e, c] = this.pin(s);
      let b = this.beacons.get(s);
      if (!b) {
        b = new Beacon(e, c, this.beaconHeight, this.beaconWidth, s.gold);
        this.beacons.set(s, b);
        this.group.add(b.group);
      } else {
        b.set(e, c);
      }
      b.group.position.set(s.x, w.height(s.x, s.z), s.z);
    }
    this.host.hud.marks = near.map(([, s]) => ({ x: s.x, z: s.z, colour: this.pin(s)[1] }));
  }

  /** The pin as drawn: the mode's look, in gold for a golden target. */
  private pin(s: Spot): [string, string] {
    const [e, c] = this.look(s);
    return s.gold ? [e, GOLD_COLOUR] : [e, c];
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      q.life -= dt;
      q.v.y -= 14 * dt;
      q.obj.position.addScaledVector(q.v, dt);
      q.obj.rotation.x += q.spin * dt;
      q.obj.rotation.y += q.spin * dt * 0.7;
      if (q.life <= 0) {
        this.group.remove(q.obj);
        const m = q.obj as THREE.Mesh;
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += dt;
      const k = r.life / RING_LIFE;
      r.mesh.scale.setScalar(1 + k * 22);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
      if (k >= 1) {
        this.group.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
      }
    }
  }

  /** What is still to aim for: the record, the next medal. */
  private goalLine(): string {
    const parts: string[] = [];
    if (this.best) {
      parts.push(this.beaten ? t('game.beaten') : t('game.best', { n: num(this.best, 0) }));
    }
    if (this.medals) {
      const i = this.medals.findIndex((m) => this.count < m);
      parts.push(i < 0 ? t('game.allMedals')
        : t('game.next', { m: MEDALS[i], n: this.medals[i] - this.count }));
    }
    return parts.join(' · ');
  }

  private render(nxt: Spot | null): void {
    const p = this.host.player;
    const left = this.limit - this.time;
    const clock = el('gTime');
    put(clock, fmt(left));
    clock.classList.toggle('low', left < 30 && this.state === 'play');
    put(el('gPoints'), num(this.score, 0));
    const mult = Math.min(MAX_MULT, this.combo);
    const multEl = el('gMult');
    put(multEl, mult > 1 ? `×${mult}` : '');
    multEl.dataset.n = String(mult);
    // bars scale rather than resize: a transform needs no layout
    css(el('gCombo').firstElementChild as HTMLElement, 'transform',
        `scaleX(${(Math.round(Math.max(0, this.comboLeft / this.comboWindow) * 50) / 50)})`);
    put(el('gScore'), this.scoreLine(), true);
    put(el('gGoal'), this.goalLine());
    const m = el('gMeter');
    css(m, 'display', this.meter ? '' : 'none');
    if (this.meter) {
      const bar = m.firstElementChild as HTMLElement;
      css(bar, 'transform', `scaleX(${Math.round(Math.max(0, Math.min(1, this.meter.value)) * 100) / 100})`);
      css(bar, 'background', this.meter.colour);
      put(m.lastElementChild as HTMLElement, this.meter.label);
    }
    const arrow = el('gArrow');
    if (nxt) {
      const dx = nxt.x - p.pos.x, dz = nxt.z - p.pos.z;
      const s = Math.sin(p.yaw), c = Math.cos(p.yaw);
      const fwd = -dx * s - dz * c;
      const right = dx * c - dz * s;
      css(arrow, 'transform', `rotate(${Math.round(Math.atan2(right, fwd) * 50) / 50}rad)`);
      css(arrow, 'visibility', '');
      put(el('gTarget'), `${nxt.gold ? '✨ ' : ''}${nxt.n} · ${distanceText(Math.hypot(dx, dz))}`);
    } else {
      css(arrow, 'visibility', 'hidden');
      put(el('gTarget'), t(this.spots.length ? 'game.none' : 'game.noTargets'));
    }
  }
}

/* --- the modes --------------------------------------------------------------- */

/** Fly Santa's sleigh over the Christmas markets. */
class MarketRun extends Game {
  private snow = new Snow();
  protected override beaconRange = 9000;
  protected override beaconCount = 14;
  protected override beaconHeight = 320;
  protected override beaconWidth = 5;
  protected override comboWindow = 12;
  protected override timeBonus = 3;
  protected override medals: [number, number, number] = [4, 8, 14];
  // the sleigh is quick already; much faster and the city cannot stream in
  protected override pace = 0.8;

  async load(): Promise<void> {
    const d = await points('markets.json');
    this.attribution = d.attribution;
    // from the air the whole city is in reach; a single-area build has
    // no market of its own, so these are not limited to the built tiles
    this.pool = d.points.map((p) => spot(p, 60));
  }

  // start over the middle of a cluster, high up
  protected override startRule = { r: 3000, min: 8 };

  override prepare(): void {
    this.spots = this.pool;
  }

  override start(): void {
    super.start();
    this.host.player.setSleigh(true);
    this.host.setNight(1);
    this.host.scene.add(this.snow.points);
  }

  override stop(): void {
    this.host.scene.remove(this.snow.points);
    this.snow.points.geometry.dispose();
    this.host.player.setSleigh(false);
    this.host.setNight(0);
    super.stop();
  }

  protected look(): [string, string] { return ['🎄', '#e8b23a']; }

  /** Shift's boost is the rush. */
  protected override rush(): number {
    const p = this.host.player;
    return Math.max(0, Math.min(1, (p.sleighSpeed / p.speedScale - 65) / 45));
  }

  protected override inReach(): boolean {
    const p = this.host.player;
    return p.pos.y - this.host.world.height(p.pos.x, p.pos.z) < 200;
  }

  protected override tick(dt: number): void {
    this.snow.update(dt, (this.host.camera as THREE.PerspectiveCamera).position);
  }

  protected reached(s: Spot): void {
    s.done = true;
    sfx.jingle();
    const p = this.host.player;
    this.award(s, p.pos.x, p.pos.y, p.pos.z);
    this.burst(p.pos.x, p.pos.y, p.pos.z, [0xc8102e, 0x2f8f4e, 0x2a62c9, 0xe8b23a], 10, 0.7);
    this.banner(this.text('hit', { name: s.n }));
  }

  protected scoreLine(): string {
    return this.text('score', { n: this.count });
  }

  protected finish(): Outcome {
    return {
      won: this.count > 0, title: this.text(this.count >= 8 ? 'won' : 'lost'),
      lines: [this.text('line', { n: this.count, of: this.spots.length }), this.attribution],
    };
  }
}

/** Hitzewelle: points for lasting the whole round. */
const HEAT_BONUS = 1000;

/** Survive the heat: shade, fountains, splash pools, bathing spots. */
class HeatWave extends Game {
  override readonly modes: Mode[] = ['foot', 'bike', 'scooter'];
  private heat = 30;
  private shade = false;
  private shadeCheck = 0;
  private warned = false;
  private survived = false;
  protected override comboWindow = 25;
  /** Pin, colour and how much each kind of spot cools you down. */
  private readonly kinds: Record<string, [string, string, number]> = {
    drink: ['💧', '#3fa9f5', 35],
    splash: ['⛲', '#38c7c0', 50],
    indoor: ['❄️', '#8c9eff', 60],
    swim: ['🏊', '#2b6fd6', 100],
  };

  async load(): Promise<void> {
    const d = await points('cool.json');
    this.attribution = d.attribution;
    this.pool = d.points.map((p) => spot(p, p[4] === 'swim' ? 40 : 9));
    this.startRule = { r: 800, min: 4 };
    this.pickRule = { r: 6000, max: 600 };
  }

  protected look(s: Spot): [string, string] {
    const k = this.kinds[s.kind] ?? this.kinds.drink;
    return [k[0], k[1]];
  }

  protected override urgency(): number {
    return (this.heat - 70) / 30;
  }

  protected override tick(dt: number): void {
    const p = this.host.player;
    this.shadeCheck -= dt;
    if (this.shadeCheck <= 0) {
      this.shadeCheck = 0.2;
      this.shade = false;
      for (const t of this.host.world.tileAt(p.pos.x, p.pos.z)?.trees ?? []) {
        const r = t.crown / 2 + 0.6;
        if (Math.abs(t.x - p.pos.x) < r && Math.abs(t.z - p.pos.z) < r
            && (t.x - p.pos.x) ** 2 + (t.z - p.pos.z) ** 2 < r * r) {
          this.shade = true;
          break;
        }
      }
    }
    // running heats you as much as it would at free-roam speed
    const rate = (0.32 + 0.02 * p.speedKmh / GAME_PACE) * (this.shade ? 0.3 : 1);
    this.heat = Math.min(100, this.heat + rate * dt);
    if (this.heat > 80 && !this.warned) {
      this.warned = true;
      sfx.warn();
      this.banner(this.text('warn'));
    }
    if (this.heat < 70) this.warned = false;
    const temp = 36.5 + this.heat / 100 * 4;
    this.meter = {
      value: this.heat / 100,
      label: `${num(temp)} °C · ${this.text(this.shade ? 'shade' : 'sun')}`,
      colour: this.heat > 80 ? '#ff4d3d' : this.heat > 50 ? '#ff9f43' : '#ffd166',
    };
    css(el('heat'), 'opacity', String(Math.round(Math.max(0, (this.heat - 40) / 60) * 85) / 100));
    if (this.heat >= 100) this.end(false);
  }

  override stop(): void {
    css(el('heat'), 'opacity', '0');
    super.stop();
  }

  protected reached(s: Spot): void {
    s.done = true;
    const k = this.kinds[s.kind] ?? this.kinds.drink;
    this.heat = Math.max(0, this.heat - k[2]);
    sfx.splash();
    const p = this.host.player;
    this.award(s, p.pos.x, p.pos.y, p.pos.z);
    this.burst(p.pos.x, p.pos.y + 1, p.pos.z, [0x7fd3ff, 0xffffff, 0x3fa9f5], 18, 0.2);
    this.banner(`${k[0]} ${this.text(this.kinds[s.kind] ? s.kind : 'drink')}`);
  }

  protected scoreLine(): string {
    return this.text('score', { n: this.count });
  }

  /** Surviving is bronze; cooling off often on the way is better. */
  protected override medal(): number {
    return this.survived ? 1 + (this.count >= 4 ? 1 : 0) + (this.count >= 8 ? 1 : 0) : 0;
  }

  protected finish(timeUp: boolean): Outcome {
    this.survived = timeUp;
    if (timeUp) this.bonus(HEAT_BONUS);
    return timeUp ? {
      won: true, title: this.text('won'),
      lines: [this.text('wonLine', { n: this.count }), this.text('bonus', { n: num(HEAT_BONUS, 0) }),
              this.attribution],
    } : {
      won: false, title: this.text('lost'),
      lines: [this.text('lostLine', { time: fmt(this.time), n: this.count }), this.text('tip'), this.attribution],
    };
  }
}

/** Water young trees from street pumps, Gieß den Kiez style. */
class GiessDenKiez extends Game {
  override readonly modes: Mode[] = ['foot', 'bike'];
  protected override beaconRange = 600;
  protected override beaconCount = 30;
  protected override beaconHeight = 14;
  protected override beaconWidth = 0.6;
  protected override comboWindow = 20;
  protected override timeBonus = 4;
  protected override medals: [number, number, number] = [3, 6, 10];
  private static readonly CAPACITY = 50;
  private water = GiessDenKiez.CAPACITY;
  private litres = 0;
  private sound = 0;

  async load(): Promise<void> {
    const res = await fetch(DATA + 'giessen.json');
    if (!res.ok) throw new Error('giessen.json missing - run pipeline/build_games.py');
    const d = await res.json() as { attribution: string; pumps: RawPoint[]; trees: number[] };
    this.attribution = d.attribution;
    const trees: Spot[] = [];
    // 80,000 young trees: one name per age, not one string each
    const names = new Map<number, string>();
    const name = (age: number) => {
      let n = names.get(age);
      if (n === undefined) {
        const years = age < 1 ? this.text('age0') : age === 1 ? this.text('age1') : this.text('ageN', { n: age });
        n = this.text('tree', { age: years });
        names.set(age, n);
      }
      return n;
    };
    for (let i = 0; i < d.trees.length; i += 3) {
      const age = d.trees[i + 2];
      const s = spot([d.trees[i], d.trees[i + 1], name(age), ''], 4.5, 'tree');
      // Gieß den Kiez: the youngest trees need the most
      s.need = age < 5 ? 30 : age < 10 ? 20 : 12;
      trees.push(s);
    }
    this.pumps = d.pumps.map((p) => spot([p[0], p[1], p[2] || this.text('pump'), p[3]], 5, 'pump'));
    this.pool = trees;
    // a pump with plenty of young trees around it
    this.startRule = { r: 300, min: 15 };
  }

  private pumps: Spot[] = [];
  protected override anchors(): Spot[] { return this.pumps; }

  override prepare(): void {
    this.spots = [...this.pick(this.pool, 2500, 1500), ...this.pick(this.pumps, 5000, 60)];
  }

  protected look(s: Spot): [string, string] {
    if (s.kind === 'pump') return ['🚰', '#5b8def'];
    return s.got > 0 ? ['🌿', '#56c271'] : ['💧', '#2fa4e7'];
  }

  /** Pumps are never done and always shown close by; while the bag is
   *  empty, they are all that matters. */
  protected override wanted(s: Spot): boolean {
    if (s.kind !== 'pump') return this.water >= 5;
    const p = this.host.player.pos;
    return this.water < 5 || Math.hypot(s.x - p.x, s.z - p.z) < 250;
  }

  /** The compass: trees while there is water, else the nearest pump. */
  protected override next(): Spot | null {
    const { x, z } = this.host.player.pos;
    const pump = this.water < 5;
    let best: Spot | null = null, bd = Infinity;
    for (const s of this.spots) {
      if (s.done || (s.kind === 'pump') !== pump) continue;
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  protected override tick(dt: number): void {
    const p = this.host.player.pos;
    let pumping = false, pouring: Spot | null = null;
    for (const s of this.spots) {
      if (Math.hypot(s.x - p.x, s.z - p.z) >= s.reach) continue;
      if (s.kind === 'pump') pumping = true;
      else if (!s.done && !pouring) pouring = s;
    }
    this.sound -= dt;
    if (pumping && this.water < GiessDenKiez.CAPACITY) {
      this.water = Math.min(GiessDenKiez.CAPACITY, this.water + 18 * dt);
      if (this.sound <= 0) { sfx.pump(); this.sound = 0.35; }
      if (this.water >= GiessDenKiez.CAPACITY) this.banner(this.text('full'));
    } else if (pouring && this.water > 0) {
      const l = Math.min(this.water, 14 * dt, pouring.need - pouring.got);
      this.water -= l;
      pouring.got += l;
      this.litres += l;
      if (this.sound <= 0) { sfx.pour(); this.sound = 0.2; }
      if (pouring.got >= pouring.need - 0.01) {
        pouring.done = true;
        sfx.collect();
        this.award(pouring);
        this.burst(pouring.x, this.host.world.height(pouring.x, pouring.z) + 2, pouring.z,
                   [0x56c271, 0x9be15d, 0x2fa4e7], 12, 0.25);
        this.banner(this.text('thanks', { name: pouring.n, l: pouring.need }));
      } else if (this.water <= 0) {
        this.banner(this.text('empty'));
      }
    }
    const watering = pouring && !pouring.done && this.water > 0;
    this.meter = {
      value: this.water / GiessDenKiez.CAPACITY,
      label: watering ? this.text('watering', { got: Math.round(pouring!.got), need: pouring!.need })
        : pumping ? this.text('pumping') : this.text('bag', { l: Math.round(this.water) }),
      colour: '#2fa4e7',
    };
  }

  protected reached(): void { /* handled continuously in tick() */ }

  protected scoreLine(): string {
    return this.text('score', { n: this.count, l: Math.round(this.litres) });
  }

  protected finish(): Outcome {
    return {
      won: this.count > 0, title: this.text(this.count >= 5 ? 'won' : 'lost'),
      lines: [this.text('line', { n: this.count, l: Math.round(this.litres) }), this.text('real'), this.attribution],
    };
  }
}

/** Ten toilets, five minutes, one bladder. */
class ToiletRush extends Game {
  private bladder = 40;
  private readonly goal = TOILET_GOAL;
  /** Seconds to spare when the last toilet was found. */
  private spare = 0;
  protected override comboWindow = 40;

  async load(): Promise<void> {
    const d = await points('toilets.json');
    this.attribution = d.attribution;
    this.pool = d.points.map((p) => spot(p, 9));
    // the goal has to be possible: enough toilets within a ride
    this.startRule = { r: 1500, min: TOILET_GOAL + 1 };
    this.pickRule = { r: 8000, max: 200 };
  }

  protected look(): [string, string] { return ['🚻', '#4fd1c5']; }

  protected override urgency(): number {
    return (this.bladder - 50) / 50;
  }

  override stop(): void {
    css(el('urge'), 'opacity', '0');
    super.stop();
  }

  protected override tick(dt: number): void {
    // full about 40 s after the last toilet
    this.bladder = Math.min(100, this.bladder + dt * 2.5);
    css(el('urge'), 'opacity', String(Math.round(Math.max(0, (this.bladder - 60) / 40) * 80) / 100));
    const full = this.bladder >= 100;
    this.pace = full ? 0.55 : 1;
    if (full && this.meter?.value !== 1) this.banner(this.text('full'));
    this.meter = {
      value: this.bladder / 100,
      label: full ? this.text('waddle') : this.text('bladder', { p: Math.round(this.bladder) }),
      colour: this.bladder > 80 ? '#f6c945' : '#9ad1e8',
    };
  }

  protected reached(s: Spot): void {
    s.done = true;
    this.bladder = 0;
    sfx.collect();
    sfx.flush();
    this.award(s);
    this.burst(s.x, this.host.world.height(s.x, s.z) + 1.5, s.z, [0x9ad1e8, 0xffffff, 0x4fd1c5], 16, 0.22);
    this.banner(this.text('hit', { name: s.n }));
    if (this.count >= this.goal) this.end(false);
  }

  protected scoreLine(): string {
    return this.text('score', { n: this.count, goal: this.goal });
  }

  /** Finding them all is bronze; finding them fast is better. */
  protected override medal(): number {
    if (this.count < this.goal) return 0;
    return 1 + (this.spare >= 30 ? 1 : 0) + (this.spare >= 60 ? 1 : 0);
  }

  protected finish(): Outcome {
    const won = this.count >= this.goal;
    const lines = [won ? this.text('wonLine', { goal: this.goal, time: fmt(this.time) })
                       : this.text('lostLine', { n: this.count, goal: this.goal })];
    if (won) {
      // every second to spare is worth something
      this.spare = Math.max(0, Math.floor(this.limit - this.time));
      this.bonus(this.spare * 25);
      lines.push(this.text('bonus', { s: this.spare, n: num(this.spare * 25, 0) }));
    }
    return { won, title: this.text(won ? 'won' : 'lost'), lines: [...lines, this.attribution] };
  }
}

/** As many Döner as you can stomach. */
class DoenerMarathon extends Game {
  override readonly modes: Mode[] = ['foot', 'bike', 'scooter'];
  private power = 0;
  private weight = 1;
  protected override comboWindow = 10;
  protected override timeBonus = 3;
  protected override medals: [number, number, number] = [3, 6, 10];

  async load(): Promise<void> {
    const d = await points('doener.json');
    this.attribution = d.attribution;
    this.pool = d.points.map((p) => spot(p, 8));
    this.startRule = { r: 600, min: 6 };
  }

  protected look(): [string, string] { return ['🥙', '#f2994a']; }

  protected override rush(): number {
    return Math.min(1, this.power / 2);
  }

  protected override tick(dt: number): void {
    this.power = Math.max(0, this.power - dt);
    this.pace = this.weight * (this.power > 0 ? 1.6 : 1);
    this.meter = this.power > 0
      ? { value: this.power / 8, label: this.text('power'), colour: '#f2994a' }
      : { value: 0, label: this.text('weight', { kg: num(this.count * 0.4) }), colour: '#f2994a' };
  }

  protected reached(s: Spot): void {
    s.done = true;
    this.power = 8;
    // each one slows you down a little for good
    this.weight = Math.max(0.6, this.weight * 0.95);
    sfx.chomp();
    this.award(s);
    this.burst(s.x, this.host.world.height(s.x, s.z) + 1.5, s.z, [0xf2994a, 0xffffff, 0xd94f30, 0x7cb342], 14, 0.25);
    this.banner(this.text('hit', { name: s.n }));
  }

  protected scoreLine(): string {
    return this.text('score', { n: this.count });
  }

  protected finish(): Outcome {
    return {
      won: this.count > 0, title: this.text(this.count >= 5 ? 'won' : 'lost'),
      lines: [this.text('line', { n: this.count, kg: num(this.count * 0.4) }), this.attribution],
    };
  }
}

export function makeGame(id: string, host: GameHost): Game {
  const info = MODE_INFO.find((m) => m.id === id)!;
  switch (id) {
    case 'markets': return new MarketRun(info, host);
    case 'heat': return new HeatWave(info, host);
    case 'giessen': return new GiessDenKiez(info, host);
    case 'toilets': return new ToiletRush(info, host);
    default: return new DoenerMarathon(info, host);
  }
}

/* --- seeds and best scores ----------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Today's course: the same start for everyone playing today. */
export function dailySeed(d = new Date()): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function randomSeed(): number {
  return 100000000 + Math.floor(Math.random() * 899999999);
}
