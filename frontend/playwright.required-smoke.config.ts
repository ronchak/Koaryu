import { defineConfig } from "@playwright/test";

const REQUIRED_SMOKE_TAG = "@required-browser-smoke";

export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    "preview-smoke.spec.ts",
    "schedule-attendance-counters.spec.ts",
  ],
  grep: new RegExp(REQUIRED_SMOKE_TAG),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 15_000,
  globalTimeout: 120_000,
  expect: {
    timeout: 5_000,
  },
  outputDir: "test-results/required-browser-smoke",
  reporter: [
    ["line"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4000",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 4000",
    env: {
      ...process.env,
      NEXT_PUBLIC_PREVIEW_MODE: "true",
    },
    url: "http://127.0.0.1:4000/login",
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
