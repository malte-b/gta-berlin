import type { ServerResponse } from 'node:http';
import { HttpError, addRun, board, checkMode, checkName, checkRun, checkSeed, claim, rateLimit, readJson,
         reply, type Req } from './_db.js';

/**
 * GET  /api/runs?mode=&seed=&limit=&name=  a course's top list, and where
 *      the named player stands on it
 * POST /api/runs  { token, name, run }      keep a finished run; answers
 *      with the board, so the game can say which place it was
 */
export default function handler(req: Req, res: ServerResponse): Promise<void> {
  return reply(res, async () => {
    if (req.method === 'GET') {
      const q = new URL(req.url ?? '', 'http://x').searchParams;
      const limit = Math.min(50, Math.max(1, Number(q.get('limit')) || 10));
      const name = q.get('name');
      return board(checkMode(q.get('mode')), checkSeed(q.get('seed')), limit, name ? checkName(name) : null);
    }
    if (req.method === 'POST') {
      rateLimit(req);
      const body = await readJson(req);
      const name = checkName(body.name);
      const run = checkRun(body.run);
      const player = await claim(body.token, name);
      await addRun(player, run);
      return board(run.mode, run.seed, 10, name);
    }
    throw new HttpError(405, 'method not allowed');
  });
}
