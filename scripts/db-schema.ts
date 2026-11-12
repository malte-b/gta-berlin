/**
 * Sets up the score tables (db/schema.sql) in the Supabase Postgres the API
 * uses (api/_pg.ts). Safe to run again.
 *
 *   npm run db:schema            DATABASE_URL, DATABASE_PASSWORD from .env or the environment
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { connection } from '../api/_pg.ts';

const c = connection();
if (!c) {
  console.error('DATABASE_URL is not set (put it in .env)');
  process.exit(1);
}

const client = new pg.Client(c);
await client.connect();
try {
  await client.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  const { rows: [n] } = await client.query<{ players: number; runs: number }>(
    'select (select count(*)::int from berlin_game.players) players, (select count(*)::int from berlin_game.runs) runs');
  console.log(`schema berlin_game ready: ${n.players} players, ${n.runs} runs`);
} finally {
  await client.end();
}
