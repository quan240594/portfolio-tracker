import { defineConfig, devices } from '@playwright/test';

// E2E for a Cognito-mode build (VITE_AUTH_MODE=cognito) without a real user pool: proves the sign-in gate fails
// closed. Cognito calls are intercepted in the spec. Own port so it can run next to the mock-mode suite.
const PORT = Number(process.env.E2E_AUTH_PORT ?? Number(process.env.E2E_PORT ?? 5174) + 100);

export default defineConfig({
  testDir: './e2e-auth',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-auth', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      VITE_AUTH_MODE: 'cognito',
      VITE_COGNITO_USER_POOL_ID: 'eu-west-1_E2ETest01',
      VITE_COGNITO_CLIENT_ID: 'e2eclientid0123456789',
      VITE_COGNITO_REGION: 'eu-west-1',
      VITE_USE_MOCKS: 'false',
    },
  },
});
