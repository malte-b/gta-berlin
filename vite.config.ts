import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// All of Berlin (pipeline/build_berlin.py) is 10-20 GB, too much for public/,
// which every build would copy into dist/. It stays in data/berlin/ at the
// repository root and the dev server serves it from there.
// BERLIN_DIR=berlin_bridges npm run dev  serves another build of it instead
const BERLIN = join(__dirname, 'data', process.env.BERLIN_DIR || 'berlin');
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
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  server: { port: 5173 },
  plugins: [berlinTiles()],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
