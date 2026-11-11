/**
 * Sets up the score tables through the Datahub's Hasura, which is the only
 * way to its Postgres: creates them (db/schema.sql), has Hasura track them,
 * links each run to its player, and gives the API's role what it may do.
 * Safe to run again. Needs the admin secret, which only the Datahub team has;
 * the API itself runs with less (api/_db.ts).
 *
 *   npm run db:schema            HASURA_* from .env or the environment
 *
 * HASURA_URL (the Datahub's by default), HASURA_ADMIN_SECRET, HASURA_SOURCE
 * (the database's name in Hasura, "default" unless set), HASURA_ROLE
 * (berlin_game unless set).
 */
import { readFileSync } from 'node:fs';

const base = (process.env.HASURA_URL || 'https://backend-api.data-hub.berlin').replace(/\/$/, '');
const secret = process.env.HASURA_ADMIN_SECRET;
const source = process.env.HASURA_SOURCE || 'default';
const role = process.env.HASURA_ROLE || 'berlin_game';
if (!secret) {
  console.error('HASURA_ADMIN_SECRET is not set (put it in .env)');
  process.exit(1);
}

async function call(path: string, body: unknown): Promise<unknown> {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hasura-admin-secret': secret! },
    body: JSON.stringify(body),
  });
  const v = await r.json() as { code?: string; error?: string };
  if (r.ok) return v;
  // running again finds what the last run made
  if (v.code === 'already-tracked' || v.code === 'already-exists') return v;
  throw new Error(`${path} ${(body as { type: string }).type}: ${v.code} ${v.error}`);
}

const meta = (type: string, args: Record<string, unknown>) => call('/v1/metadata', { type, args: { source, ...args } });
const players = { schema: 'berlin_game', name: 'players' };
const runs = { schema: 'berlin_game', name: 'runs' };

await call('/v2/query', { type: 'run_sql', args: {
  source, sql: readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8') } });
await meta('pg_track_table', { table: players });
await meta('pg_track_table', { table: runs });
await meta('pg_create_object_relationship', { table: runs, name: 'player',
                                              using: { foreign_key_constraint_on: 'player_id' } });

// a player: taken or re-claimed by token (insert, or update on conflict), and
// read back for the board; never the token hash, never hidden set
await meta('pg_create_insert_permission', { table: players, role,
  permission: { check: {}, columns: ['token_hash', 'name', 'name_key'] } });
await meta('pg_create_update_permission', { table: players, role,
  permission: { filter: {}, check: {}, columns: ['name', 'name_key'] } });
await meta('pg_create_select_permission', { table: players, role,
  permission: { filter: {}, columns: ['id', 'name', 'name_key', 'hidden'] } });
// a run: written once, read for the board
await meta('pg_create_insert_permission', { table: runs, role,
  permission: { check: {}, columns: ['player_id', 'mode', 'seed', 'score', 'count', 'medal', 'combo'] } });
await meta('pg_create_select_permission', { table: runs, role,
  permission: { filter: {}, columns: ['player_id', 'mode', 'seed', 'score', 'count', 'medal', 'combo', 'created_at'] } });

const r = await call('/v2/query', { type: 'run_sql', args: { source, read_only: true, sql:
  'select (select count(*) from berlin_game.players), (select count(*) from berlin_game.runs)' } }) as
  { result: string[][] };
console.log(`schema berlin_game ready for role ${role}: ${r.result[1][0]} players, ${r.result[1][1]} runs`);
