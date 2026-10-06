import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: process.env.CI ? 4 : undefined,
  testMatch: /(?:v2-liff|p1-b-entry|p1-c-navigation|p1-c-races|p2-a-entry|p2-b-identity|p2-c-timeline|p2-d-quick-entry)\.spec\.ts/,
  outputDir: "output/playwright/results",
  reporter: "line",
  use: {
    ...devices["iPhone 13"],
    baseURL: "http://localhost:3108",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium-iphone", use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } } },
    { name: "webkit-iphone", use: { ...devices["iPhone 13"], browserName: "webkit", viewport: { width: 390, height: 844 } } },
    { name: "chromium-393", testMatch: /(?:p1-b-entry|p1-c-navigation|p1-c-races|p2-a-entry|p2-b-identity|p2-c-timeline|p2-d-quick-entry)\.spec\.ts/, use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 393, height: 852 } } },
    { name: "webkit-393", testMatch: /(?:p1-b-entry|p1-c-navigation|p1-c-races|p2-a-entry|p2-b-identity|p2-c-timeline|p2-d-quick-entry)\.spec\.ts/, use: { ...devices["iPhone 13"], browserName: "webkit", viewport: { width: 393, height: 852 } } },
    { name: "chromium-wide", testMatch: /v2-liff\.spec\.ts/, use: { browserName: "chromium", viewport: { width: 430, height: 932 } } },
  ],
  webServer: {
    command: "pnpm exec next dev -p 3108",
    env: {
      NEXT_PUBLIC_LIFF_ID: "test-liff-id",
      V2_LEDGER_ENABLED: "1",
    },
    url: "http://localhost:3108",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
