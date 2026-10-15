import { defineConfig, devices } from '@playwright/test';

// Parallel worktrees must not share a server: set E2E_PAGES_PORT to a free port of your own.
// E2E against the GitHub Pages build (`pnpm build:pages`), served under /portfolio-tracker/ by a static server that
// mimics Pages (404.html fallback for deep links). Run via `pnpm test:e2e:pages`, which builds first.
const PORT = Number(process.env.E2E_PAGES_PORT ?? 4180);
const PAGES_BASE = '/portfolio-tracker/';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'pages.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-pages', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/serve-pages.mjs --port ${PORT} --base ${PAGES_BASE}`,
    url: `http://localhost:${PORT}${PAGES_BASE}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
