import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser", timeout: 30_000, fullyParallel: true, workers: 3,
  outputDir: "./test-results", reporter: "list",
  use: { baseURL: "http://127.0.0.1:3107", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    { command: "npx vite --config tests/vite.config.ts", url: "http://127.0.0.1:3107/tests/browser/harness.html", reuseExistingServer: false, timeout: 30_000 },
    { command: "npm run start -- --port 3108", url: "http://127.0.0.1:3108", reuseExistingServer: false, timeout: 60_000 },
  ],
});
