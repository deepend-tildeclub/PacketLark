import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/ui',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1260, height: 820 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
