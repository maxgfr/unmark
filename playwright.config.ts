// Three engines and two phones, because "probably works in Safari" is not a
// claim this project is allowed to make.
//
// Everything here runs against a built `dist` served over HTTP, never the dev
// server: the Content-Security-Policy is injected at build time, the service
// worker only exists in a build, and a bug that only appears under the shipped
// CSP is exactly the bug worth catching.
//
// The two mobile projects carry `hasTouch`, and the image selection test uses
// `page.touchscreen` rather than a mouse. That path had never been run once.

import { defineConfig, devices } from '@playwright/test'

const PORT = 4179

export default defineConfig({
  testDir: './tests/e2e',
  // Image work is genuinely slow on a cold WebKit, and a flaky timeout reads as
  // a real failure and wastes more time than the wait costs.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: process.env['CI'] ? 2 : undefined,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: `http://localhost:${PORT}/unmark/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  webServer: {
    command: `node tests/e2e/serve.mjs ${PORT}`,
    url: `http://localhost:${PORT}/unmark/`,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } },
    },
    {
      // 390x844 is an iPhone 14. The Text tab is the only thing that has ever
      // been looked at on a phone, and only in a screenshot.
      name: 'webkit-mobile',
      use: { ...devices['iPhone 14'] },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
})
