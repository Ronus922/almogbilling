import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

// Local: DATABASE_URL, SETTINGS_ENC_KEY, … come from .env.local (never
// overriding what the shell already set). CI sets them as job env.
dotenv.config({ path: '.env.local', quiet: true });

const PORT = Number(process.env.E2E_PORT ?? 3100);
// `localhost`, not 127.0.0.1: the app is the production build, so its session
// cookie carries `Secure`, and Playwright's request context only sends Secure
// cookies over plain http to localhost. The server binds to the same name so
// both sides resolve it identically (v4 or v6).
const HOST = 'localhost';
const BASE_URL = `http://${HOST}:${PORT}`;
const MAILPIT_SMTP_PORT = process.env.MAILPIT_SMTP_PORT ?? '55525';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'he-IL',
    trace: 'retain-on-failure',
  },
  projects: [
    // Logs in through the form once (test 1) and stores the session cookie.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/state.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'bash scripts/e2e/start-server.sh',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOSTNAME: HOST,
      APP_URL: BASE_URL,
      INTERNAL_BASE_URL: BASE_URL,
      // Route the app's SMTP at Mailpit (docker-compose.e2e.yml).
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: MAILPIT_SMTP_PORT,
      SMTP_REQUIRE_TLS: 'false',
    },
  },
});
