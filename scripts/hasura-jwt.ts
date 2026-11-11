/**
 * Signs the JWT the score API signs in to Hasura with (api/_db.ts), for the
 * berlin_game role alone, and writes it into .env as HASURA_TOKEN. It is not
 * printed, so it stays out of terminals and logs; copy it from .env into
 * Vercel's environment variables.
 *
 *   npm run db:token
 *
 * Needs HASURA_JWT_KEY in .env: the "key" of the Hasura server's
 * HASURA_GRAPHQL_JWT_SECRET, which must be {"type":"HS256","key":"..."}.
 * Hasura issues no tokens itself, it only checks them against that key. The
 * token does not expire; changing the key on the server revokes it.
 * HASURA_ROLE and HASURA_CLAIMS_NAMESPACE as the server has them, if not
 * berlin_game and Hasura's default.
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const key = process.env.HASURA_JWT_KEY;
const role = process.env.HASURA_ROLE || 'berlin_game';
const ns = process.env.HASURA_CLAIMS_NAMESPACE || 'https://hasura.io/jwt/claims';
if (!key || key.length < 32) {
  console.error('HASURA_JWT_KEY is not set, or shorter than the 32 characters HS256 needs (put it in .env)');
  process.exit(1);
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const body = b64(JSON.stringify({
  sub: 'berlin-game-api',
  iat: Math.floor(Date.now() / 1000),
  [ns]: { 'x-hasura-allowed-roles': [role], 'x-hasura-default-role': role },
}));
const token = `${head}.${body}.${b64(createHmac('sha256', key).update(`${head}.${body}`).digest())}`;

const file = new URL('../.env', import.meta.url);
const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith('HASURA_TOKEN=')) : [];
while (lines.length && lines[lines.length - 1] === '') lines.pop();
writeFileSync(file, [...lines, `HASURA_TOKEN=${token}`, ''].join('\n'));
console.log(`HASURA_TOKEN for role ${role} written to .env`);
