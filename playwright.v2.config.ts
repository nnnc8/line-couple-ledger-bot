import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /v2-liff\.spec\.ts/,
  outputDir: "output/playwright/v2-results",
  reporter: "line",
  use: {
    ...devices["iPhone 13"],
    baseURL: "http://localhost:3109",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "v2-chromium-iphone", use: { ...devices["iPhone 13"], browserName: "chromium" } },
    { name: "v2-webkit-iphone", use: { ...devices["iPhone 13"], browserName: "webkit" } },
    { name: "v2-chromium-wide", use: { browserName: "chromium", viewport: { width: 430, height: 932 } } },
  ],
  webServer: {
    command: "pnpm exec next dev -p 3109",
    env: {
      NEXT_PUBLIC_LIFF_ID: "test-liff-id",
      V2_LEDGER_ENABLED: "1",
    },
    url: "http://localhost:3109",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
