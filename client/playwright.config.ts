import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';

// E2E против настоящего стека: Express :3101 с временной БД + Next :3102.
// Сид: владелец boss/boss-pass (migrateToV3_ из OWNER_LOGIN/OWNER_PASSWORD),
// типы белья — setup.setup() в команде запуска сервера.
const SERVER_DIR = path.resolve(__dirname, '..', 'server');
const DB = path.join(os.tmpdir(), `cleanlab-e2e-${process.pid}.sqlite`);
const API_PORT = 3101;
const WEB_PORT = 3102;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'ru-RU',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node -e "require('./setup').setup(); require('./index.js')"`,
      cwd: SERVER_DIR,
      port: API_PORT,
      reuseExistingServer: false,
      env: {
        DB_PATH: DB,
        PORT: String(API_PORT),
        OWNER_LOGIN: 'boss',
        OWNER_PASSWORD: 'boss-pass',
        LAUNDRY_NAME: 'E2E Прачка',
        BOT_TOKEN: '',
        TV_KEY: 'tv-e2e',
      },
    },
    {
      // next dev держит эксклюзивный лок на проект — для E2E используем прод-сборку
      // (next build выполняется скриптом test:e2e до запуска тестов).
      command: 'npx next start --port ' + WEB_PORT,
      cwd: __dirname,
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      env: { API_ORIGIN: `http://localhost:${API_PORT}` },
      timeout: 120_000,
    },
  ],
});
