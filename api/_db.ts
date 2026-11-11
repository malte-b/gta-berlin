import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * What the score API shares: the way to the board's tables, the checks on
 * what comes in, and the board query. Runs on Vercel as serverless functions
 * (api/runs.ts, api/player.ts), and in `npm run dev` through the same
 * handlers (vite.config.ts). The browser never talks to the database itself.
 * Files starting with _ are not routes on Vercel.
 *
 * The tables (db/schema.sql) are in the Datahub's Postgres, which is only
 * reached through its Hasura GraphQL API: HASURA_URL, the Datahub's by
 * default. The API signs in with either
 *  - HASURA_TOKEN, a JWT the Datahub issues for the berlin_game role, or
 *  - HASURA_ADMIN_SECRET, acting as HASURA_ROLE (berlin_game unless set),
 *    so that role's permissions still apply to every request.
 * They live in Vercel's environment variables and, for development, in .env.
 */

const DATAHUB = 'https://backend-api.data-hub.berlin';

function auth(env = process.env): Record<string, string> | null {
  if (env.HASURA_TOKEN) return { Authorization: `Bearer ${env.HASURA_TOKEN}` };
  if (env.HASURA_ADMIN_SECRET) {
    return { 'x-hasura-admin-secret': env.HASURA_ADMIN_SECRET, 'x-hasura-role': env.HASURA_ROLE || 'berlin_game' };
  }
  return null;
}

/** An error Hasura answered with; code is e.g. constraint-violation. */
export class GqlError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message);
  }
}

/** One GraphQL request to Hasura. Without credentials the board is off: 503. */
export async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const headers = auth();
  if (!headers) throw new HttpError(503, 'no database configured');
  const r = await fetch(`${(process.env.HASURA_URL || DATAHUB).replace(/\/$/, '')}/v1/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(6000),
  });
  const body = await r.json() as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
  const e = body.errors?.[0];
  if (e) throw new GqlError(e.message, e.extensions?.code);
  if (!r.ok || !body.data) throw new Error(`hasura answered ${r.status}`);
  return body.data;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type Req = IncomingMessage & { body?: unknown };

/** Runs a handler and turns what it returns or throws into a JSON reply. */
export async function reply(res: ServerResponse, fn: () => Promise<unknown>): Promise<void> {
  let status = 200;
  let body: unknown;
  try {
    body = await fn();
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      body = { error: e.message };
    } else {
      console.error(e);
      status = 500;
      body = { error: 'server error' };
    }
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** The JSON body. Vercel has parsed it already; the dev server has not. */
export async function readJson(req: Req): Promise<Record<string, unknown>> {
  let v = req.body;
  if (v === undefined) {
    let s = '';
    for await (const chunk of req) {
      s += chunk;
      if (s.length > 4096) throw new HttpError(413, 'too large');
    }
    v = s;
  }
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { throw new HttpError(400, 'bad json'); }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad json');
  return v as Record<string, unknown>;
}

/**
 * At most LIMIT writes a minute from one address, per instance. Only a
 * brake: serverless instances come and go, so a firewall rule on Vercel is
 * the real limit. Addresses stay in memory and are never stored.
 */
const LIMIT = 30;
const recent = new Map<string, number[]>();

export function rateLimit(req: Req): void {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() || req.socket.remoteAddress || '';
  const now = Date.now();
  const list = (recent.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= LIMIT) throw new HttpError(429, 'slow down');
  list.push(now);
  recent.set(ip, list);
  if (recent.size > 5000) recent.clear();
}

/** 2-20 letters, digits, spaces, - _ . ; returns the cleaned name. */
export function checkName(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError(400, 'bad name');
  const name = v.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{N} _.-]{2,20}$/u.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
    throw new HttpError(400, 'bad name');
  }
  return name;
}

/** The browser's secret: 32 hex digits. Only its hash is kept. */
export function tokenHash(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v)) throw new HttpError(400, 'bad token');
  return createHash('sha256').update(v).digest('hex');
}

/**
 * The player behind a token, under this name: new, renamed or as before.
 * A name someone else holds is refused.
 */
export async function claim(token: unknown, name: string): Promise<number> {
  try {
    const d = await gql<{ insert_berlin_game_players_one: { id: number | string } | null }>(
      `mutation ($token_hash: String!, $name: String!, $name_key: String!) {
         insert_berlin_game_players_one(
           object: { token_hash: $token_hash, name: $name, name_key: $name_key },
           on_conflict: { constraint: players_token_hash_key, update_columns: [name, name_key] }
         ) { id }
       }`,
      { token_hash: tokenHash(token), name, name_key: name.toLowerCase() });
    if (!d.insert_berlin_game_players_one) throw new Error('player not written');
    return Number(d.insert_berlin_game_players_one.id);
  } catch (e) {
    // the token's own row is updated, so this is name_key: someone else's
    if (e instanceof GqlError && e.code === 'constraint-violation') throw new HttpError(409, 'name taken');
    throw e;
  }
}

/** Keep a run of a player's. */
export async function addRun(player: number, run: RunIn): Promise<void> {
  await gql(
    `mutation ($run: berlin_game_runs_insert_input!) {
       insert_berlin_game_runs(objects: [$run]) { affected_rows }
     }`,
    { run: { player_id: player, ...run } });
}

/**
 * The most a mode's run can plausibly reach. Generous: they catch numbers
 * typed in by hand, not a clever cheat - anyone can send anything.
 * A target is worth at most 100 points x5 combo x3 gold; heat adds 1000 for
 * lasting the round, toilets 25 per second to spare out of 120.
 */
const TARGET_MAX = 1500;
const MODES: Record<string, { count: number; bonus: number }> = {
  markets: { count: 80, bonus: 0 },
  heat: { count: 80, bonus: 1000 },
  giessen: { count: 80, bonus: 0 },
  toilets: { count: 10, bonus: 120 * 25 },   // the round ends at 5
  doener: { count: 80, bonus: 0 },
};

export function checkMode(v: unknown): string {
  if (typeof v !== 'string' || !(v in MODES)) throw new HttpError(400, 'bad mode');
  return v;
}

export function checkSeed(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw new HttpError(400, 'bad seed');
  return n;
}

export interface RunIn {
  mode: string;
  seed: number;
  score: number;
  count: number;
  medal: number;
  combo: number;
}

export function checkRun(v: unknown): RunIn {
  if (!v || typeof v !== 'object') throw new HttpError(400, 'bad run');
  const r = v as Record<string, unknown>;
  const mode = checkMode(r.mode);
  const seed = checkSeed(r.seed);
  const [score, count, medal, combo] = [r.score, r.count, r.medal, r.combo].map((x) => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0) throw new HttpError(400, 'bad run');
    return x;
  });
  const cap = MODES[mode];
  if (count > cap.count || score > count * TARGET_MAX + cap.bonus || medal > 3 || combo > count) {
    throw new HttpError(422, 'implausible run');
  }
  return { mode, seed, score, count, medal, combo };
}

export interface Entry {
  rank: number;
  name: string;
  count: number;
  score: number;
  medal: number;
}

export interface Board {
  /** How many players have a run on the course. */
  players: number;
  top: Entry[];
  /** The named player, wherever they stand. */
  me: Entry | null;
}

/**
 * A course's top list: each player's best run, the most targets first and
 * points between those that reached as many (web/src/scores.ts, better).
 */
export async function board(mode: string, seed: number, limit: number, name: string | null): Promise<Board> {
  // each player's best comes from Hasura; the places are counted here, as
  // GraphQL has no rank(). One course a day stays small.
  const d = await gql<{ berlin_game_runs: (Omit<Entry, 'rank' | 'name'> & {
    created_at: string; player: { name: string; name_key: string };
  })[] }>(
    `query ($mode: String!, $seed: Int!) {
       berlin_game_runs(
         where: { mode: { _eq: $mode }, seed: { _eq: $seed }, player: { hidden: { _eq: false } } },
         distinct_on: player_id,
         order_by: [{ player_id: asc }, { count: desc }, { score: desc }, { created_at: asc }]
       ) { count score medal created_at player { name name_key } }
     }`,
    { mode, seed });
  const best = d.berlin_game_runs
    .sort((a, b) => b.count - a.count || b.score - a.score || a.created_at.localeCompare(b.created_at));
  const ranked: (Entry & { name_key: string })[] = [];
  for (const [i, r] of best.entries()) {
    const tie = i > 0 && r.count === best[i - 1].count && r.score === best[i - 1].score;
    ranked.push({ rank: tie ? ranked[i - 1].rank : i + 1, name: r.player.name, name_key: r.player.name_key,
                  count: r.count, score: r.score, medal: r.medal });
  }
  const entry = (e: Entry): Entry => ({ rank: e.rank, name: e.name, count: e.count, score: e.score, medal: e.medal });
  const mine = name === null ? undefined : ranked.find((e) => e.name_key === name.toLowerCase());
  return {
    players: ranked.length,
    top: ranked.filter((e) => e.rank <= limit).slice(0, limit).map(entry),
    me: mine ? entry(mine) : null,
  };
}
