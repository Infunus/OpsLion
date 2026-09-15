import { defineConfig } from '@playwright/test';
import path from 'node:path';

const source = process.env.OPSLION_TEST_WERSS_SOURCE || path.resolve('we-mp-rss');
export default defineConfig({
  testDir: './native-rss', timeout: 30_000, workers: 1,
  outputDir: '../test-results/native-rss', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3189', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
  webServer: {
    command: `npm --prefix "${path.join(source, 'web_ui')}" run preview -- --host 127.0.0.1 --port 3189 --strictPort`,
    url: 'http://127.0.0.1:3189', reuseExistingServer: false, timeout: 30_000,
  },
});
