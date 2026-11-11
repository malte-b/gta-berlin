import { MEDALS, MODE_INFO, dailySeed, modeText, type Result } from './games';
import { num, onLang, t } from './i18n';
import { playerName, setPlayerName, standing, type Board } from './ranking';
import { Scoreboard } from './scoreboard';
import { bestScore, type Run } from './scores';

/**
 * The start screen: free roam or one of the game modes.
 *
 * A game is played on a course - a seed that picks a fair start - so that
 * scores mean something: clicking a mode plays today's course, the same for
 * everyone today. That is the only choice offered - one course a day is
 * easy to understand and to compare. A course also travels as a link,
 * #play=<mode>:<seed>, to challenge someone on it.
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
  private readonly scoresBtn = document.getElementById('scoresBtn')!;
  private readonly scoreboard = new Scoreboard();
  /** The game last played, whose tab the high scores open on. */
  private lastMode: string | undefined;
  /** Where the last run stands on the shared board, once known. */
  private standing: Promise<Board> | null = null;
  open = true;

  constructor(private readonly onPick: (c: Choice) => void) {
    onLang(() => { this.render(); this.redraw?.(); });
    // the icon opens the high scores in a box over the menu
    this.scoresBtn.addEventListener('click', () => this.scoreboard.show(this.lastMode));
  }

  /** Clears the panel above the cards. */
  private closePanel(): void {
    this.result.classList.remove('on');
    this.redraw = null;
  }

  /** Redraws the panel above the cards in a new language, if it can. */
  private redraw: (() => void) | null = null;

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
    this.closePanel();
    this.scoreboard.close();
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

  /** After a game: the score, its place on the shared board, and what next. */
  showResult(id: string, seed: number | null, r: Result, newBest: boolean, run: Run): void {
    this.lastMode = id;
    this.standing = seed !== null && playerName() ? standing(run) : null;
    this.drawResult(id, seed, r, newBest, run);
    this.show();
  }

  private drawResult(id: string, seed: number | null, r: Result, newBest: boolean, run: Run): void {
    const info = MODE_INFO.find((i) => i.id === id)!;
    const best = seed === null ? null : bestScore(id, seed);
    const shown = num(best ?? 0, 0);
    const course = seed === null ? t('menu.unranked')
      : seed === dailySeed() ? t('menu.today', { best: shown }) : t('menu.course', { seed, best: shown });
    // the result's own lines were written in the language it ended in
    const kids: HTMLElement[] = [
      h('h3', '', `${r.medal ? MEDALS[r.medal - 1] : info.emoji} ${r.title}`),
      h('div', 'big', t('game.points', { n: num(r.score, 0) })),
      h('p', '', newBest ? t('menu.newBest', { course }) : course),
    ];
    // close enough to taste it: say how close
    if (!newBest && best !== null && best > r.score && r.score >= best * 0.7) {
      kids.push(h('p', 'short', t('menu.short', { n: num(best - r.score, 0) })));
    }
    if (seed !== null) kids.push(this.rankLine(id, seed, r, newBest, run));
    kids.push(
      ...r.lines.slice(0, -1).map((l) => h('p', '', l)),
      h('p', '', [t('menu.stats', { c: r.combo }), r.golds ? t('menu.golds', { g: r.golds }) : '']
        .filter(Boolean).join(' · ')),
      h('p', 'src', t('menu.data', { src: r.lines[r.lines.length - 1] })),
    );
    const btns: [string, () => void, boolean?][] = [
      [t('menu.again'), () => this.pick({ id, seed })],
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
    this.redraw = () => this.drawResult(id, seed, r, newBest, run);
  }

  /** The run's place among everyone on the course; without a name, a field to join. */
  private rankLine(id: string, seed: number, r: Result, newBest: boolean, run: Run): HTMLElement {
    if (this.standing) {
      const p = h('p', 'rank', '…');
      this.standing.then(
        (b) => {
          p.textContent = b.me ? t(b.local ? 'board.localRank' : 'board.rank', { rank: b.me.rank, n: b.players }) : '';
        },
        (e) => { p.textContent = t((e as Error).message === '409' ? 'board.taken' : 'board.offline'); p.className = 'src'; });
      return p;
    }
    const form = h('form', 'join');
    const input = h('input', '');
    input.type = 'text';
    input.maxLength = 20;
    input.setAttribute('autocomplete', 'nickname');
    input.spellcheck = false;
    input.placeholder = t('board.namePh');
    const go = h('button', '', t('board.joinBtn'));
    const msg = h('p', 'src');
    const row = h('div', 'row');
    row.append(input, go);
    form.append(h('p', '', t('board.join')), row, msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      go.disabled = true;
      msg.textContent = '…';
      const res = await setPlayerName(input.value);
      go.disabled = false;
      if (res !== 'ok' && res !== 'local') {
        msg.textContent = t(`board.${res}`);
        return;
      }
      this.standing = standing(run);
      this.drawResult(id, seed, r, newBest, run);
    });
    return form;
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
                               : t('menu.todayBest', { n: num(best, 0) }),
                             () => this.pick({ id: m.id, seed: today }));
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
