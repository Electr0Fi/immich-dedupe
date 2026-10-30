import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:4175', trace: 'retain-on-failure', serviceWorkers: 'block' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4175 --strictPort',
    wait: { stdout: /Local:/ }, reuseExistingServer: false,
    env: { VITE_API_BASE_URL: 'http://fake-api.invalid' },
  },
});
