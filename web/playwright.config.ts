import { defineConfig } from '@playwright/test';

const exe = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 45_000,
  use: { baseURL: 'http://localhost:3100', launchOptions: { executablePath: exe }, locale: 'es-HN', timezoneId: 'America/Tegucigalpa' },
  webServer: {
    command: 'node web/e2e/reset-db.mjs && npm -w server run start',
    cwd: '..',
    url: 'http://localhost:3100/api/health',
    reuseExistingServer: false,
    env: { NODE_ENV: 'development', PORT: '3100', DATABASE_URL: 'postgres://nova:nova@localhost:5432/nova_e2e', ALLOW_REGISTRATION: 'true' },
  },
  projects: [
    { name: 'movil', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
    { name: 'escritorio', use: { viewport: { width: 1366, height: 860 } } },
  ],
});
