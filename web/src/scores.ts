/**
 * Your own scores, kept in this browser.
 *
 * Every finished game is a run: mode, course, points and the rest. Runs are
 * appended to one list in local storage (the newest RUN_CAP; a phone has
 * little room and a few hundred games say enough), and the best score per
 * course is kept apart, so it survives the list being trimmed - it is what a
 * course's record and "new best" are measured against.
 *
 * Shaped for a shared board later: a run is plain data with nothing
 * browser-specific in it, so the same record can be POSTed to an API in front
 * of a Postgres table on the Datahub and compared with everyone else's on the
 * same course. See README, "Scores".
 */

export interface Run {
  mode: string;
  /** The course; null where it was played unranked, right where you stood. */
  seed: number | null;
  score: number;
  /** Targets reached. */
  count: number;
  /** 0 none, 1-3 bronze to gold. */
  medal: number;
  combo: number;
  /** When it ended, ms since 1970. */
  at: number;
}

const RUNS = 'berlin.runs';
const RUN_CAP = 300;

function read<T>(key: string, dflt: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : JSON.parse(v) as T;
  } catch {
    return dflt;
  }
}

function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode, or full */ }
}

/** Every run kept, oldest first. */
export function runs(): Run[] {
  const list = read<Run[]>(RUNS, []);
  return Array.isArray(list) ? list : [];
}

/**
 * Scores only compare on the same course, so the best is kept per seed. They
 * are points; the older berlin.best.* keys counted targets and are left be.
 */
export function bestScore(mode: string, seed: number): number | null {
  const v = read<number | null>(`berlin.points.${mode}.${seed}`, null);
  return typeof v === 'number' ? v : null;
}

/** Keep a finished run; true if it is a new best on its course. */
export function recordRun(run: Run): boolean {
  const list = runs();
  list.push(run);
  write(RUNS, list.slice(-RUN_CAP));
  if (run.seed === null) return false;
  const best = bestScore(run.mode, run.seed);
  if (best !== null && run.score <= best) return false;
  write(`berlin.points.${run.mode}.${run.seed}`, run.score);
  return true;
}

export interface ModeStats {
  played: number;
  /** The best run on any course. */
  best: Run | null;
  /** The best run on today's course. */
  today: Run | null;
  /** How many runs earned each medal, bronze to gold. */
  medals: [number, number, number];
}

export function stats(mode: string, todaySeed: number): ModeStats {
  const s: ModeStats = { played: 0, best: null, today: null, medals: [0, 0, 0] };
  for (const r of runs()) {
    if (r.mode !== mode) continue;
    s.played++;
    if (!s.best || r.score > s.best.score) s.best = r;
    if (r.seed === todaySeed && (!s.today || r.score > s.today.score)) s.today = r;
    if (r.medal > 0) s.medals[r.medal - 1]++;
  }
  return s;
}
