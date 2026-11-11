import { MODE_INFO, dailySeed, modeText } from './games';
import { lang, num, onLang, t } from './i18n';
import { cleanName, fetchBoard, playerName, setPlayerName, type Board } from './ranking';
import { runsOf, stats } from './scores';

/**
 * The high scores, in a box over the start screen: a tab per game, each with
 * today's course on the shared board and your own record in that mode, and
 * above them the name you play under. Medals stay in the game: on a list
 * sorted by what was reached they add nothing.
 */

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export class Scoreboard {
  private readonly root = document.getElementById('board')!;
  private tab = MODE_INFO[0].id;
  private body = h('div', 'tabbody');
  /** Counts the tabs drawn, so a board that arrives late can tell it is stale. */
  private drawn = 0;
  open = false;

  constructor() {
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    addEventListener('keydown', (e) => {
      if (this.open && e.code === 'Escape') this.close();
    });
    onLang(() => { if (this.open) this.render(); });
  }

  /** Open, on a game's tab if given. */
  show(mode?: string): void {
    if (mode && MODE_INFO.some((m) => m.id === mode)) this.tab = mode;
    this.open = true;
    this.root.classList.add('on');
    this.render();
    (this.root.querySelector('.tabs .on') as HTMLElement | null)?.focus();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('on');
    this.root.replaceChildren();
  }

  private render(): void {
    const box = h('div', 'box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const x = h('button', 'x', '✕');
    x.setAttribute('aria-label', t('board.close'));
    x.addEventListener('click', () => this.close());
    const title = h('h3', '', t('scores.title'));
    title.id = 'boardTitle';
    box.setAttribute('aria-labelledby', title.id);

    const tabs = h('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    for (const m of MODE_INFO) {
      const b = h('button', m.id === this.tab ? 'on' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(m.id === this.tab));
      b.title = modeText(m.id, 'title');
      b.append(h('span', 'te', m.emoji), h('span', 'tt', modeText(m.id, 'title')));
      b.addEventListener('click', () => {
        this.tab = m.id;
        for (const o of tabs.children) {
          o.classList.toggle('on', o === b);
          o.setAttribute('aria-selected', String(o === b));
        }
        this.drawTab();
      });
      tabs.append(b);
    }

    this.body = h('div', 'tabbody');
    this.body.setAttribute('role', 'tabpanel');
    box.append(x, title, this.nameForm(), tabs, this.body, h('p', 'src', t('board.privacy')));
    this.root.replaceChildren(box);
    this.drawTab();
  }

  /** The name you play under: take one, or change it. */
  private nameForm(): HTMLElement {
    const form = h('form', 'name');
    const label = h('label', '', t('board.name'));
    const input = h('input', '');
    input.id = 'boardName';
    label.htmlFor = input.id;
    input.type = 'text';
    input.maxLength = 20;
    input.setAttribute('autocomplete', 'nickname');
    input.spellcheck = false;
    input.placeholder = t('board.namePh');
    input.value = playerName() ?? '';
    const save = h('button', '', t('board.save'));
    const msg = h('p', 'msg');
    const row = h('div', 'row');
    row.append(input, save);
    form.append(label, row, msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (cleanName(input.value) === playerName()) return;
      save.disabled = true;
      msg.textContent = '…';
      const r = await setPlayerName(input.value);
      save.disabled = false;
      msg.textContent = t(`board.${r}`);
      msg.classList.toggle('bad', r !== 'ok' && r !== 'local');
      if (r === 'ok' || r === 'local') {
        input.value = playerName() ?? '';
        this.drawTab();
      }
    });
    return form;
  }

  /** The open tab: today's course on the board, then your own numbers. */
  private drawTab(): void {
    const mode = this.tab;
    const today = dailySeed();
    const drawn = ++this.drawn;
    const date = new Intl.DateTimeFormat(lang === 'de' ? 'de-DE' : 'en-GB', { day: 'numeric', month: 'long' });
    const list = h('div', 'list');
    list.append(h('p', 'dim', t('board.loading')));
    this.body.replaceChildren(h('p', 'sub', t('board.today', { date: date.format(new Date()) })), list);

    fetchBoard(mode, today).then(
      (b) => { if (drawn === this.drawn) list.replaceChildren(...this.boardRows(mode, b)); },
      () => { if (drawn === this.drawn) list.replaceChildren(h('p', 'dim', t('board.offline'))); });

    const name = playerName();
    const s = stats(mode, today, name);
    this.body.append(h('p', 'sub', t('board.mine')));
    if (!s.played) {
      this.body.append(h('p', 'dim', t('board.notPlayed')));
      return;
    }
    this.body.append(h('p', '', [
      t('board.record', { n: modeText(mode, 'unit', { n: s.best!.count }) }),
      t('board.todayMine', { n: s.today ? modeText(mode, 'unit', { n: s.today.count }) : '–' }),
      t('board.played', { n: s.played }),
    ].join(' · ')));
    const when = new Intl.DateTimeFormat(lang === 'de' ? 'de-DE' : 'en-GB',
                                         { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const recent = h('div', 'recent');
    for (const r of runsOf(name).filter((r) => r.mode === mode).slice(-5).reverse()) {
      recent.append(h('div', '', `${modeText(mode, 'unit', { n: r.count })} · ${t('game.points', { n: num(r.score, 0) })}`
        + ` · ${when.format(r.at)}`
        + (r.seed === null ? ` · ${t('scores.unranked')}` : r.seed !== today ? ` · ${t('board.course', { seed: r.seed })}` : '')));
    }
    this.body.append(recent);
  }

  /** Each player's best: targets in the mode's own words, points small, as they only break ties. */
  private boardRows(mode: string, b: Board): HTMLElement[] {
    const note = b.local ? [h('p', 'dim', t('board.localNote'))] : [];
    if (!b.top.length) return [h('p', 'dim', t('board.empty')), ...note];
    const me = playerName()?.toLowerCase();
    const table = h('table', 'scores');
    const row = (e: Board['top'][number]) => {
      const tr = h('tr', e.name && e.name.toLowerCase() === me ? 'me' : '');
      tr.append(h('td', 'n', `${e.rank}.`), h('td', 'who', e.name || t('board.noName')),
                h('td', 'n', modeText(mode, 'unit', { n: e.count })), h('td', 'n pts', num(e.score, 0)));
      return tr;
    };
    table.append(...b.top.map(row));
    if (b.me && !b.top.some((e) => e.rank === b.me!.rank && e.name === b.me!.name)) {
      const gap = h('tr', 'gap');
      gap.append(h('td', '', '…'));
      table.append(gap, row(b.me));
    }
    if (b.local) return [table, ...note];
    const out: HTMLElement[] = [table, h('p', 'dim', t('board.players', { n: b.players }))];
    if (!playerName()) out.push(h('p', 'dim', t('board.joinHint')));
    return out;
  }
}
