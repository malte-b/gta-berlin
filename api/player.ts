import type { ServerResponse } from 'node:http';
import { HttpError, checkName, claim, rateLimit, readJson, reply, type Req } from './_db.js';

/** POST /api/player { token, name }: take a name, or change yours. 409 if it is someone else's. */
export default function handler(req: Req, res: ServerResponse): Promise<void> {
  return reply(res, async () => {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    rateLimit(req);
    const body = await readJson(req);
    const name = checkName(body.name);
    await claim(body.token, name);
    return { name };
  });
}
