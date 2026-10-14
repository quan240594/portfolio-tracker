import { defineConfig, devices } from '@playwright/test';

// Parallel worktrees must not share a dev server: set E2E_PORT to a free port of your own.
const PORT = Number(process.env.E2E_PORT ?? 5174);

export default defineConfig({
  testDir: './e2e',
  testIgnore: 'pages.spec.ts', // runs against the Pages build via playwright.pages.config.ts
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm dev:mock --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
