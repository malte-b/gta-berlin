import { MODE_INFO, dailySeed } from './games';
import { better, isSent, markSent, nameRuns, runs, runsOf, type Run } from './scores';

/**
 * The shared board: everyone's best on a course, kept in Postgres on the
 * Datahub behind a small API (api/). Joining is a nickname, nothing more;
 * until a player picks one, their runs stay in this browser (scores.ts).
 *
 * A name is held by a random token this browser keeps, so nobody else can
 * post under it. Each name has its own, so friends taking turns on one device
 * each stay on the board; picking another name switches player rather than
 * renaming one. Clearing the browser's storage loses the names with it.
 *
 * Where there is no board to ask - no network, no API on a static host, no
 * database behind it - the boards are made from this browser's runs alone,
 * and a name is kept here until the board can take it.
 */

const API = '/api/';
/** The name played under now. */
const NAME = 'berlin.name';
/** Each name's token, by its lower-case key. */
const TOKENS = 'berlin.players';
/** From before names had a token each: the one token, of the name then in NAME. */
const OLD_TOKEN = 'berlin.player';
const OFFLINE = 'offline';
/** After the board failed to answer, how long to go by this browser alone. */
const RETRY = 60_000;
let downUntil = 0;

export interface Entry {
  rank: number;
  /** Empty on a local board for games from before any name was picked. */
  name: string;
  count: number;
  score: number;
  medal: number;
}

export interface Board {
  /** How many players have a run on the course. */
  players: number;
  top: Entry[];
  /** You, wherever you stand. */
  me: Entry | null;
  /** Made from this browser's runs alone: each name's best here. */
  local?: boolean;
}

function get(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function set(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* private mode */ }
}

/** Your name on the board; null until you pick one. */
export function playerName(): string | null {
  return get(NAME);
}

function tokens(): Record<string, string> {
  let map: Record<string, string> = {};
  try {
    const v: unknown = JSON.parse(get(TOKENS) ?? '{}');
    if (v && typeof v === 'object') map = v as Record<string, string>;
  } catch { /* start afresh */ }
  const old = get(OLD_TOKEN);
  const name = get(NAME);
  if (old && name) {
    map[name.toLowerCase()] ??= old;
    set(TOKENS, JSON.stringify(map));
    try { localStorage.removeItem(OLD_TOKEN); } catch { /* private mode */ }
  }
  return map;
}

/** A name's secret, made on its first use. getRandomValues works over plain http too. */
function token(name: string): string {
  const map = tokens();
  const key = name.toLowerCase();
  let t = map[key];
  if (!t || !/^[0-9a-f]{32}$/.test(t)) {
    t = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    map[key] = t;
    set(TOKENS, JSON.stringify(map));
  }
  return t;
}

/** The name as the server will take it, or null: 2-20 letters, digits, spaces, - _ . */
export function cleanName(v: string): string | null {
  const name = v.normalize('NFC').trim().replace(/\s+/g, ' ');
  return /^[\p{L}\p{N} _.-]{2,20}$/u.test(name) && /[\p{L}\p{N}]/u.test(name) ? name : null;
}

/**
 * Fails with the status where the server turned the request down, and with
 * OFFLINE where there is no board to ask; then it is left alone for a while.
 */
async function call<T>(path: string, body?: unknown): Promise<T> {
  if (performance.now() < downUntil) throw new Error(OFFLINE);
  let r: Response | null = null;
  try {
    r = await fetch(API + path, body === undefined ? { signal: AbortSignal.timeout(8000) } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* no network, or too slow */ }
  // 404 and 405 are a host without the API, 5xx one without a database
  if (r && !r.ok && r.status < 500 && r.status !== 404 && r.status !== 405) throw new Error(String(r.status));
  // a static host may answer with its index.html
  const v = r?.ok ? await r.json().catch(() => undefined) as T | undefined : undefined;
  if (v !== undefined) return v;
  downUntil = performance.now() + RETRY;
  throw new Error(OFFLINE);
}

/** The board this browser can make alone: each name's best run on the course here. */
function localBoard(mode: string, seed: number, name: string | null): Board {
  const best = new Map<string, Run>();
  for (const r of runs()) {
    if (r.mode !== mode || r.seed !== seed) continue;
    const key = r.name?.toLowerCase() ?? '';
    const b = best.get(key);
    if (!b || better(r, b) < 0) best.set(key, r);
  }
  const list = [...best.values()].sort((a, b) => better(a, b) || a.at - b.at);
  const entries: Entry[] = [];
  for (const [i, r] of list.entries()) {
    const rank = i && !better(r, list[i - 1]) ? entries[i - 1].rank : i + 1;
    entries.push({ rank, name: r.name ?? '', count: r.count, score: r.score, medal: r.medal });
  }
  const me = name === null ? undefined : entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
  return { players: entries.length, top: entries.slice(0, 10), me: me ?? null, local: true };
}

/** Boards fetched a moment ago, so flicking through the tabs does not ask again. */
const cache = new Map<string, { at: number; board: Promise<Board> }>();

/** A course's top ten and where you stand on it; this browser's own without a board. */
export function fetchBoard(mode: string, seed: number): Promise<Board> {
  const key = `${mode}:${seed}`;
  const hit = cache.get(key);
  if (hit && performance.now() - hit.at < 20_000) return hit.board;
  const name = playerName();
  const board = call<Board>(`runs?mode=${mode}&seed=${seed}${name ? `&name=${encodeURIComponent(name)}` : ''}`)
    .catch((e: Error) => {
      if (e.message !== OFFLINE) throw e;
      // made fresh each time, so the next look asks the board again
      cache.delete(key);
      return localBoard(mode, seed, name);
    });
  cache.set(key, { at: performance.now(), board });
  board.catch(() => cache.delete(key));
  return board;
}

/**
 * Put a finished run on the board, under your name. Resolves to the course's
 * board with you on it - this browser's, if there is no board to ask; it goes
 * up with the next look once there is. Rejects without a name, or unranked.
 */
export async function submitRun(run: Run): Promise<Board> {
  const name = run.name ?? playerName();
  if (!name || run.seed === null) throw new Error('not ranked');
  const { mode, seed, score, count, medal, combo } = run;
  let board: Board;
  try {
    board = await call<Board>('runs', { token: token(name), name, run: { mode, seed, score, count, medal, combo } });
  } catch (e) {
    if ((e as Error).message === OFFLINE) return localBoard(mode, seed, name);
    throw e;
  }
  markSent(run.at);
  cache.set(`${mode}:${seed}`, { at: performance.now(), board: Promise.resolve(board) });
  return board;
}

/** Where a run stands: sent with it, or asked for if it went already. */
export function standing(run: Run): Promise<Board> {
  const seed = run.seed;
  if (!isSent(run.at) || seed === null) return submitRun(run);
  return fetchBoard(run.mode, seed).then((b) => (b.local ? localBoard(run.mode, seed, run.name ?? playerName()) : b));
}

/** 'local': kept in this browser, as there is no board to ask. */
export type NameResult = 'ok' | 'local' | 'taken' | 'invalid' | 'offline';

/**
 * Play under a name: a new one, or one played under here before. Games from
 * before any name was picked become the first name's, and today's best in
 * each mode goes up, so they count. Without a board the name is kept here,
 * and claimed with the first run that goes up.
 */
export async function setPlayerName(v: string): Promise<NameResult> {
  const name = cleanName(v);
  if (!name) return 'invalid';
  let result: NameResult = 'ok';
  try {
    await call('player', { token: token(name), name });
  } catch (e) {
    const m = (e as Error).message;
    if (m !== OFFLINE) return m === '409' ? 'taken' : m === '400' ? 'invalid' : 'offline';
    result = 'local';
  }
  set(NAME, name);
  cache.clear();
  nameRuns(name);
  if (result === 'ok') {
    const today = dailySeed();
    const mine = runsOf(name).filter((r) => r.seed === today);
    await Promise.allSettled(MODE_INFO
      .map((m) => mine.filter((r) => r.mode === m.id).sort(better)[0])
      .filter((r): r is Run => !!r && !r.sent)
      .map((r) => submitRun(r)));
  }
  return result;
}
