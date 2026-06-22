import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "output/playwright/results",
  reporter: "line",
  use: {
    ...devices["iPhone 13"],
    browserName: "chromium",
    baseURL: "http://localhost:3108",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec next dev -p 3108",
    url: "http://localhost:3108",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
