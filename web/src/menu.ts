import { MODE_INFO, bestScore, dailySeed, modeText, randomSeed, type Result } from './games';
import { onLang, t } from './i18n';

/**
 * The start screen: free roam or one of the game modes.
 *
 * A game is played on a course - a seed that picks a fair start - so that
 * scores mean something: clicking a mode plays today's course, the same for
 * everyone today; 🎲 rolls a new one; 📍 plays right where you stand, which
 * is unranked because nobody else can start there. A course travels as a
 * link, #play=<mode>:<seed>, to challenge someone on it.
 */

export type Choice = { id: 'free' } | { id: string; seed: number | null };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function courseLink(id: string, seed: number): string {
  return `${location.origin}${location.pathname}#play=${id}:${seed}`;
}

/** A course from the URL, if the page was opened with one. */
export function linkedCourse(): { id: string; seed: number } | null {
  const m = /play=([a-z]+):(\d+)/.exec(location.hash);
  if (!m || !MODE_INFO.some((i) => i.id === m[1])) return null;
  return { id: m[1], seed: Number(m[2]) };
}

export class Menu {
  private readonly boot = document.getElementById('boot')!;
  private readonly modes = document.getElementById('modes')!;
  private readonly result = document.getElementById('result')!;
  open = true;

  constructor(private readonly onPick: (c: Choice) => void) {
    onLang(() => { this.render(); this.redraw?.(); });
  }

  /** Redraws the panel above the cards in a new language, if it can. */
  private redraw: (() => void) | null = null;

  /** A mode's unit, singular for one. */
  private unit(id: string, n: number): string {
    return modeText(id, n === 1 ? 'unit1' : 'unit');
  }

  /** The world has loaded: show the choices. */
  ready(): void {
    this.boot.classList.add('ready');
    const linked = linkedCourse();
    if (linked) this.challenge(linked.id, linked.seed);
    this.render();
  }

  show(): void {
    this.open = true;
    this.boot.style.display = '';
    this.boot.classList.add('over');
    if (document.pointerLockElement) document.exitPointerLock();
    this.render();
  }

  hide(): void {
    this.open = false;
    this.boot.style.display = 'none';
    this.result.classList.remove('on');
    this.redraw = null;
  }

  private pick(c: Choice): void {
    this.hide();
    this.onPick(c);
  }

  /** A shared course: offer it at the top. */
  private challenge(id: string, seed: number): void {
    const info = MODE_INFO.find((i) => i.id === id)!;
    this.result.replaceChildren(
      h('h3', '', t('menu.challenge', { emoji: info.emoji, title: modeText(id, 'title') })),
      h('p', '', t('menu.challengeText', { seed })),
      this.buttons([[t('menu.start'), () => this.pick({ id, seed })]]),
    );
    this.result.classList.add('on');
    this.redraw = () => this.challenge(id, seed);
  }

  /** After a game: the score and what next. */
  showResult(id: string, seed: number | null, r: Result, newBest: boolean): void {
    const info = MODE_INFO.find((i) => i.id === id)!;
    const best = seed === null ? null : bestScore(id, seed);
    const course = seed === null ? t('menu.unranked')
      : seed === dailySeed() ? t('menu.today', { best: best ?? 0 }) : t('menu.course', { seed, best: best ?? 0 });
    // the result's own lines were written in the language it ended in
    const kids: HTMLElement[] = [
      h('h3', '', `${info.emoji} ${r.title}`),
      h('div', 'big', `${r.score} ${this.unit(id, r.score)}`),
      h('p', '', newBest ? t('menu.newBest', { course }) : course),
      ...r.lines.slice(0, -1).map((l) => h('p', '', l)),
      h('p', 'src', t('menu.data', { src: r.lines[r.lines.length - 1] })),
    ];
    const btns: [string, () => void, boolean?][] = [
      [t('menu.again'), () => this.pick({ id, seed })],
      [t('menu.newCourse'), () => this.pick({ id, seed: randomSeed() }), true],
      [t('menu.freeRoam'), () => this.pick({ id: 'free' }), true],
    ];
    if (seed !== null) {
      btns.push([t('menu.share'), () => {
        const url = courseLink(id, seed);
        void navigator.clipboard?.writeText(url).then(
          () => { share.textContent = t('menu.copied'); },
          () => { share.textContent = url; });
      }, true]);
    }
    const row = this.buttons(btns);
    const share = row.lastElementChild as HTMLButtonElement;
    kids.push(row);
    this.result.replaceChildren(...kids);
    this.result.classList.add('on');
    this.show();
    this.redraw = () => this.showResult(id, seed, r, newBest);
  }

  /** A game left before the end. */
  showAbandoned(): void {
    this.result.replaceChildren(h('p', '', t('menu.abandoned')));
    this.result.classList.add('on');
    this.show();
    this.redraw = () => this.showAbandoned();
  }

  private buttons(list: [string, () => void, boolean?][]): HTMLElement {
    const row = h('div', 'rb');
    for (const [label, fn, alt] of list) {
      const b = h('button', alt ? 'alt' : '', label);
      b.addEventListener('click', fn);
      row.append(b);
    }
    return row;
  }

  private render(): void {
    const today = dailySeed();
    const free = this.card('🧭', t('menu.free.title'), t('menu.free.blurb'),
      t('menu.free.source'), '', () => this.pick({ id: 'free' }));
    free.classList.add('free');
    const cards = [free];
    for (const m of MODE_INFO) {
      const best = bestScore(m.id, today);
      const card = this.card(m.emoji, modeText(m.id, 'title'), modeText(m.id, 'blurb'), modeText(m.id, 'source'),
                             best === null ? t('menu.notPlayed')
                               : t('menu.todayBest', { n: best, unit: this.unit(m.id, best) }),
                             () => this.pick({ id: m.id, seed: today }));
      const extra = h('div', 'rb');
      extra.style.justifyContent = 'flex-start';
      extra.style.marginTop = '4px';
      for (const [label, seed] of [['random', -1], ['here', null]] as const) {
        const b = h('button', 'alt', t(`menu.${label}`));
        b.title = t(`menu.${label}Title`);
        b.style.padding = '4px 9px';
        b.style.fontSize = '10.5px';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.pick({ id: m.id, seed: seed === null ? null : randomSeed() });
        });
        extra.append(b);
      }
      card.append(extra);
      cards.push(card);
    }
    this.modes.replaceChildren(...cards);
  }

  private card(emoji: string, title: string, blurb: string, source: string, best: string,
               fn: () => void): HTMLElement {
    const c = h('div', 'mode');
    c.tabIndex = 0;
    c.setAttribute('role', 'button');
    c.append(h('span', 'me', emoji), h('span', 'mt', title), h('span', 'mb', blurb));
    if (best) c.append(h('span', 'best', best));
    c.append(h('span', 'ms', source));
    c.addEventListener('click', fn);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') fn(); });
    return c;
  }
}
