import { defineConfig } from '@playwright/test'

// Dedicated config for capturing the dashboard-kezikonyv (user manual)
// screenshots. Deliberately separate from the root playwright.config.ts
// (which is scoped to tests/smoke and enforces the SMOKELIVE815 guard for
// the CI smoke suite) -- this is authoring tooling, not a pass/fail test
// suite, and its own DASHBOARD_URL guard below serves the same purpose:
// never silently point at a live instance.
const baseURL = process.env.DASHBOARD_URL
if (!baseURL) {
  throw new Error(
    [
      'DASHBOARD_URL is not set.',
      'Point it at the dashboard instance to screenshot, e.g.:',
      '  DASHBOARD_URL=http://localhost:3420 npx playwright test --config=docs/dashboard-kezikonyv/playwright.screenshots.config.ts',
    ].join('\n'),
  )
}

export default defineConfig({
  testDir: './',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
})
