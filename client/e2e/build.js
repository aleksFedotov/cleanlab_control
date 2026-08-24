// Сборка для E2E. Rewrite /api/* запекает destination в .next/routes-manifest.json
// на этапе `next build`, поэтому API_ORIGIN нужен здесь, а не только в `next start`
// (иначе e2e молча ходит на дефолтный localhost:3100 — чужой dev-сервер).
const { spawnSync } = require('node:child_process');

const r = spawnSync('npx', ['next', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, API_ORIGIN: 'http://localhost:3101' },
  shell: process.platform === 'win32',
});
process.exit(r.status ?? 1);
