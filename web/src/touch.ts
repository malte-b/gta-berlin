import nipplejs from 'nipplejs';

/**
 * Touch controls for phones and tablets: a virtual joystick on the left
 * (nipplejs) to move, a drag anywhere on the right to look, and a few
 * buttons. They drive the game through the same key codes as the keyboard -
 * the joystick holds W/A/S/D (and Shift when pushed to the edge), a button
 * presses its key - so every mode, vehicle and game rule works unchanged.
 * How far the stick is pushed also goes to onStick, which sets the pace on
 * foot: a little walks, more runs, the edge sprints - and the knob lights up.
 *
 * Shown when the primary pointer is coarse, i.e. a finger. A laptop with a
 * touch screen keeps its keyboard and mouse UI.
 */

export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches;
}

/** Joystick deflection past which a direction counts as held. */
const DEAD = 0.3;
/** Deflection that sprints: at the edge (force goes past 1 when the thumb does). */
const SPRINT = 0.9;
const KNOB = 'rgba(255,180,84,.85)';
const KNOB_SPRINT = 'rgba(255,214,64,1)';
/** Radians per pixel of drag; a thumb travels less than a mouse. */
const LOOK = 2.4;

export interface TouchButton {
  /** Fixed, or worked out again a few times a second (the vehicle button
   *  shows the vehicle it switches to). */
  label: string | (() => string);
  code: string | (() => string);
  /** Whether it does anything right now; hidden when not. */
  show?: () => boolean;
}

export class TouchControls {
  private readonly held = new Set<string>();
  private readonly root = document.getElementById('touch')!;

  /**
   * look(dx, dy) turns the view by pixel deltas, the way the mouse does;
   * buttons are pressed as key codes, or as a function returning one (the
   * vehicle button cycles, and shows what it cycles to).
   */
  constructor(private readonly look: (dx: number, dy: number) => void, buttons: TouchButton[],
              private readonly onStick: (push: number | null) => void = () => {}) {
    document.body.classList.add('touch');
    this.joystick();
    this.lookArea();
    const bar = document.getElementById('touchButtons')!;
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = typeof b.label === 'function' ? b.label() : b.label;
      if (b.show) this.toggles.push([el, b.show]);
      if (typeof b.label === 'function') this.labels.push([el, b.label]);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const code = typeof b.code === 'function' ? b.code() : b.code;
        this.key('keydown', code);
        // a press long enough for the frame loop to see it
        const up = () => { this.key('keyup', code); el.removeEventListener('pointerup', up); };
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('pointerleave', up);
      });
      bar.append(el);
    }
  }

  private readonly toggles: [HTMLElement, () => boolean][] = [];
  private readonly labels: [HTMLElement, () => string][] = [];
  private refreshIn = 0;

  /** Show only the buttons that do something now; a few times a second. */
  refresh(): void {
    if (--this.refreshIn > 0) return;
    this.refreshIn = 15;
    for (const [el, show] of this.toggles) {
      const display = show() ? '' : 'none';
      if (el.style.display !== display) el.style.display = display;
    }
    for (const [el, label] of this.labels) {
      const text = label();
      if (el.textContent !== text) el.textContent = text;
    }
  }

  private key(type: 'keydown' | 'keyup', code: string): void {
    dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  }

  private hold(code: string, on: boolean): void {
    if (on === this.held.has(code)) return;
    if (on) this.held.add(code); else this.held.delete(code);
    this.key(on ? 'keydown' : 'keyup', code);
  }

  private release(): void {
    for (const code of [...this.held]) this.hold(code, false);
    this.onStick(null);
  }

  private joystick(): void {
    const zone = document.getElementById('touchMove')!;
    const stick = nipplejs.create({
      zone, mode: 'dynamic', size: 120, threshold: 0.1,
      color: { front: KNOB, back: 'rgba(255,255,255,.18)' },
    });
    stick.on('move', (e) => {
      const { x, y } = e.data.vector;
      this.hold('KeyW', y > DEAD);
      this.hold('KeyS', y < -DEAD);
      this.hold('KeyD', x > DEAD);
      this.hold('KeyA', x < -DEAD);
      const sprint = e.data.force >= SPRINT;
      this.hold('ShiftLeft', sprint);
      this.onStick(Math.min(1, e.data.force));
      const knob = e.data.instance.ui?.front;
      if (knob) knob.style.background = sprint ? KNOB_SPRINT : KNOB;
    });
    stick.on('end', () => this.release());
    // a lost touch (an incoming call, the app switcher) must not leave you running
    addEventListener('blur', () => this.release());
  }

  private lookArea(): void {
    const area = document.getElementById('touchLook')!;
    const last = new Map<number, [number, number]>();
    area.addEventListener('pointerdown', (e) => {
      area.setPointerCapture(e.pointerId);
      last.set(e.pointerId, [e.clientX, e.clientY]);
    });
    area.addEventListener('pointermove', (e) => {
      const p = last.get(e.pointerId);
      if (!p) return;
      this.look((e.clientX - p[0]) * LOOK, (e.clientY - p[1]) * LOOK);
      last.set(e.pointerId, [e.clientX, e.clientY]);
    });
    const end = (e: PointerEvent) => last.delete(e.pointerId);
    area.addEventListener('pointerup', end);
    area.addEventListener('pointercancel', end);
  }

  set visible(on: boolean) {
    this.root.style.display = on ? '' : 'none';
    if (!on) this.release();
  }
}
