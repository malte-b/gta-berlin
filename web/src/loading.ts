import { modeText } from './games';
import { t } from './i18n';
import { LoadingArt } from './loadingart';

/**
 * The screen between picking a game and its countdown. It covers the city
 * while the course is set up and the tiles around the start stream in, so
 * nobody sees free roam flash by or a half-built street at "go". Each game
 * has its own colours and a small 3D scene in the game's look
 * (loadingart.ts): snow for the markets, a blistering sun, a watering can
 * over a street tree, a flush seen from above, a turning Döner spit.
 */

interface Theme {
  /** Background: top glow, then the base it fades into. */
  glow: string;
  base: string;
  accent: string;
}

const THEMES: Record<string, Theme> = {
  markets: { glow: '#27406e', base: '#070b18', accent: '#f2c14e' },
  heat: { glow: '#c2521c', base: '#1f0906', accent: '#ffb347' },
  giessen: { glow: '#2f6b3a', base: '#07140b', accent: '#7ee0a0' },
  toilets: { glow: '#3a4f86', base: '#090d1a', accent: '#8fb8ff' },
  doener: { glow: '#8a4a1c', base: '#170a04', accent: '#ffcf70' },
};

export class GameLoader {
  private readonly el = document.getElementById('gameLoading')!;
  private readonly art = new LoadingArt(document.getElementById('glCanvas') as HTMLCanvasElement,
                                       document.getElementById('glArt')!);
  private readonly title = document.getElementById('glTitle')!;
  private readonly blurb = document.getElementById('glBlurb')!;
  private readonly bar = document.getElementById('glBar')!;
  private readonly line = document.getElementById('glLine')!;
  private readonly keys = document.getElementById('glKeys')!;
  private readonly play = document.getElementById('glPlay')!;
  private readonly back = document.getElementById('glBack')!;
  private shown = 0;
  private timer = 0;
  private touch = false;
  private settle: ((go: boolean) => void) | null = null;
  /** The player backed out: whoever is loading should stop at its next step. */
  cancelled = false;

  constructor() {
    this.play.addEventListener('click', () => this.settle?.(true));
    this.back.addEventListener('click', () => this.cancel());
    // before main.ts's own keys, which do nothing while a game loads
    addEventListener('keydown', (e) => {
      if (!this.el.classList.contains('on')) return;
      if (e.code === 'Escape') this.cancel();
      else if (this.settle && (e.code === 'Enter' || e.code === 'Space')) {
        e.preventDefault();
        this.settle(true);
      }
    }, true);
  }

  /** Back to the menu, now or as soon as the current step is done. */
  private cancel(): void {
    this.cancelled = true;
    this.settle?.(false);
  }

  /** touch: show what the thumbs do instead of the keys. */
  show(id: string, touch = false): void {
    this.touch = touch;
    this.cancelled = false;
    const th = THEMES[id] ?? THEMES.markets;
    const s = this.el.style;
    s.setProperty('--gl-glow', th.glow);
    s.setProperty('--gl-base', th.base);
    s.setProperty('--gl-accent', th.accent);
    this.title.textContent = modeText(id, 'title');
    this.blurb.textContent = modeText(id, 'blurb');
    this.keys.replaceChildren(...controls(id, touch));
    this.play.textContent = t('load.play');
    this.back.textContent = t('load.back');

    const lines = t(`load.${id}`).split('|');
    let n = Math.floor(Math.random() * lines.length);
    const next = () => {
      this.line.classList.remove('in');
      void this.line.offsetWidth;                 // restart the fade
      this.line.textContent = lines[n++ % lines.length];
      this.line.classList.add('in');
    };
    next();
    clearInterval(this.timer);
    this.timer = window.setInterval(next, 1800);

    this.shown = 0;
    this.bar.style.width = '0%';
    this.el.classList.remove('ready');
    this.el.classList.add('on');
    // after the screen is laid out: the scene places itself over the spacer
    this.art.show(id);
  }

  /** 0 to 1; never goes back, even when more to load turns up. */
  progress(f: number): void {
    this.shown = Math.max(this.shown, Math.min(1, f));
    this.bar.style.width = `${(4 + this.shown * 96).toFixed(1)}%`;
  }

  /**
   * Everything is in: swap the bar for the start button and wait. True to
   * play, false to go back to the menu. Players can read the controls for
   * as long as they like.
   */
  ready(): Promise<boolean> {
    if (this.cancelled) return Promise.resolve(false);
    clearInterval(this.timer);
    this.line.textContent = t(this.touch ? 'load.readyTouch' : 'load.ready');
    this.el.classList.add('ready');
    this.play.focus({ preventScroll: true });
    return new Promise((done) => {
      this.settle = (go) => { this.settle = null; done(go); };
    });
  }

  hide(): void {
    this.settle?.(false);
    clearInterval(this.timer);
    this.el.classList.remove('on');
    this.art.hide();
  }
}

const MOUSE = `<svg class="mouse" viewBox="0 0 16 24" aria-label="🖱" role="img">
  <rect x="1" y="1" width="14" height="22" rx="7" fill="rgba(255,255,255,.1)" stroke="currentColor" stroke-width="1.5"/>
  <path d="M8 1v8M1.4 9h13.2" stroke="currentColor" stroke-width="1.2" opacity=".55"/>
  <rect x="7" y="4" width="2" height="3.4" rx="1" fill="currentColor"/>
</svg>`;

/**
 * The controls as rows of keys and what they do: the mode's own, then the
 * ones every game shares; the key `mouse` is drawn as one. A row without
 * keys is a tip on how to play. On a phone, what the thumbs do instead,
 * with the mode's tips.
 */
function controls(id: string, touch: boolean): HTMLElement[] {
  const parse = (key: string) => t(key).split('|').map((r) => r.split('=') as [string, string]);
  const own = parse(`load.keys.${id}`);
  const rows = touch
    ? [...parse(id === 'markets' ? 'load.touch.markets' : 'load.touch'), ...own.filter(([k]) => !k)]
    : [...own.filter(([k]) => k), ...parse('load.keys.common'), ...own.filter(([k]) => !k)];
  return rows.flatMap(([keys, what]) => {
    if (!keys) {
      const tip = document.createElement('span');
      tip.className = 'tip';
      tip.textContent = what;
      return [tip];
    }
    // a key per word on a keyboard; a gesture or button stays whole
    const words = touch ? [keys] : keys.split(' ');
    const meanings = what.split(', ');
    // as many keys as meanings: each key with its own - 1 on foot, 2 bike,
    // 3 scooter reads better than 1 2 3 and a list. The number keys side by
    // side in one row, others a row each.
    if (words.length > 1 && meanings.length === words.length) {
      if (words.every((w) => /^\d$/.test(w))) {
        const row = document.createElement('span');
        row.className = 'pairs';
        words.forEach((w, i) => {
          const pair = document.createElement('span');
          pair.append(key(w), meanings[i]);
          row.append(pair);
        });
        return [row];
      }
      return words.flatMap((w, i) => cells([w], meanings[i]));
    }
    return cells(words, what);
  });
}

/** A row of the table: the keys, then what they do. */
function cells(words: string[], what: string): HTMLElement[] {
  const k = document.createElement('span');
  k.className = 'k';
  k.append(...words.map(key));
  const label = document.createElement('span');
  label.textContent = what;
  return [k, label];
}

/** One key cap, or the mouse drawn as a mouse. */
function key(word: string): Element {
  if (word === 'mouse') {
    const t = document.createElement('template');
    t.innerHTML = MOUSE;
    return t.content.firstElementChild!;
  }
  const kbd = document.createElement('kbd');
  kbd.textContent = word;
  return kbd;
}
