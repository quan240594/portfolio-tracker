import { defineConfig, devices } from '@playwright/test';

// E2E for a GitHub-mode build (VITE_AUTH_MODE=github): the Worker serves the SPA and the API on one origin and keeps the
// sign-in in an HttpOnly cookie. /auth/* and /api/* are answered by route mocks in the spec. Own port so it can run
// next to the mock-mode and Cognito suites.
const PORT = Number(process.env.E2E_GITHUB_PORT ?? Number(process.env.E2E_PORT ?? 5174) + 200);

export default defineConfig({
  testDir: './e2e-github',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-github', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      VITE_AUTH_MODE: 'github',
      VITE_USE_MOCKS: 'false',
    },
  },
});
