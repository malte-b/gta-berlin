import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import player from './api/player';
import runs from './api/runs';

// All of Berlin (pipeline/build_berlin.py) is 10-20 GB, too much for public/,
// which every build would copy into dist/. It stays in data/berlin/ at the
// repository root and the dev server serves it from there.
// BERLIN_DIR=berlin_bridges npm run dev  serves another build of it instead
const preferred = existsSync(join(__dirname, 'data/berlin_refined/world.json')) ? 'berlin_refined' : 'berlin';
const BERLIN = join(__dirname, 'data', process.env.BERLIN_DIR || preferred);
const TYPES: Record<string, string> = {
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.hdr': 'image/vnd.radiance',
};

function berlinTiles(): Plugin {
  return {
    name: 'berlin-tiles',
    configureServer(server) {
      server.middlewares.use('/data/berlin/', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]);
        const file = normalize(join(BERLIN, rel));
        if (!file.startsWith(BERLIN + sep)) return next();
        let size: number;
        try {
          const st = statSync(file);
          if (!st.isFile()) return next();
          size = st.size;
        } catch {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
        res.setHeader('Content-Length', size);
        if (file.endsWith('/world.json') || file.endsWith('/tile.json')) res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}

// The score API (api/) runs as serverless functions on Vercel; here the dev
// server answers for them, with DATABASE_* from .env at the repository root.
function scoreApi(): Plugin {
  return {
    name: 'score-api',
    configureServer(server) {
      server.middlewares.use('/api/runs', (req, res) => void runs(req, res));
      server.middlewares.use('/api/player', (req, res) => void player(req, res));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'DATABASE_');
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('DATABASE_') && v) process.env[k] ??= v;
  }
  return {
    root: 'web',
    publicDir: 'public',
    server: { port: 5173 },
    plugins: [berlinTiles(), scoreApi()],
    build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  };
});
