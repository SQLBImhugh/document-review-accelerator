import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: 'e2e.spec.mjs',
  workers: 1,
  fullyParallel: false,
  outputDir: '.local/test-results',
  reporter: 'list',
  use: {
    browserName: 'chromium', channel: 'msedge', headless: true,
    viewport: { width: 1600, height: 1100 }, colorScheme: 'dark', screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'node test/ui-host.mjs', url: 'http://127.0.0.1:8088/healthz',
    reuseExistingServer: false, timeout: 30000
  }
});
