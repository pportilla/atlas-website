import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 210_000,
  use: {
    baseURL: process.env.ATLAS_SITE_URL || "http://127.0.0.1:8028/",
    headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  webServer: process.env.ATLAS_SITE_URL ? undefined : {
    command: "python3 -m http.server 8028 --bind 127.0.0.1 --directory dist",
    url: "http://127.0.0.1:8028/",
    reuseExistingServer: false,
  }
});
