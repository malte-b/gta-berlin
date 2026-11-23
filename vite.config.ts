import { defineConfig, loadEnv, type Plugin } from 'vite';
import player from './api/player';
import runs from './api/runs';

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
    envDir: __dirname,
    publicDir: 'public',
    server: { port: 5173 },
    plugins: [scoreApi()],
    build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  };
});
