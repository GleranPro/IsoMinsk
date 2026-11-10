/**
 * Isometric Minsk — Playwright configuration (QA / Integration).
 *
 * Scope & assumptions:
 *  - The app is a single-page Vite dev-server app. Playwright starts (or reuses)
 *    the Vite server on http://127.0.0.1:5173 and drives Chromium at 1600x900.
 *  - Exactly one worker: the renderer is WebGL2 + a single machine; running
 *    several hardware-accelerated Chromium instances in parallel produces
 *    flaky GPU timing (and the machine has one GPU).
 *  - retries: 0 and timeout: 90 s on purpose. A flaky test must be visible to
 *    the team, not quietly retried. The renderer becoming ready is bounded by
 *    the tests themselves (60 s), which leaves headroom inside the 90 s budget.
 *  - `outputDir` holds traces / failure screenshots / videos under test-results/.
 *    Successful screenshot baselines are written by scripts/qa/capture.mjs into
 *    screenshots/ (both directories are git-ignored).
 *
 * WebGL in headless Chromium:
 *  Chromium's headless GPU stack does not use the host GPU by default. We force
 *  the ANGLE SwiftShader backend so WebGL2 is available deterministically on
 *  machines without a GPU in the session (CI, RDP, Windows service context).
 *  `--enable-unsafe-swiftshader` is required since Chrome 120 for software
 *  WebGL to be exposed at all.
 */

import { defineConfig } from '@playwright/test';

/** The dev server is authoritative here; keep in sync with the app's docs/TESTING.md. */
const DEV_SERVER_PORT = Number(process.env.QA_PORT || 5173);
const DEV_SERVER_URL = `http://127.0.0.1:${DEV_SERVER_PORT}`;

/** Shared Chromium flags: deterministic software WebGL2 in headless mode. */
const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];

/**
 * Hardware GPU in headless Chromium (opt-in via QA_GPU=1).
 * Playwright's default headless mode uses SwiftShader; forcing ANGLE/D3D11 makes
 * headless use the real GPU (verified: RTX 3080 / D3D11 on this machine). Use it
 * for realistic FPS numbers and much faster e2e runs; keep the default for CI
 * determinism and machines without a GPU.
 */
const GPU_ARGS = [
  '--use-gl=angle',
  '--use-angle=d3d11',
  '--ignore-gpu-blocklist',
  '--enable-gpu',
];

const USE_GPU = process.env.QA_GPU === '1';
const CHROMIUM_ARGS = USE_GPU ? GPU_ARGS : SWIFTSHADER_ARGS;

export default defineConfig({
  testDir: 'tests/e2e',

  /* Artifacts (traces, failure screenshots, videos) land here. */
  outputDir: 'test-results',

  /* One machine, one GPU, one WebGL context at a time. */
  workers: 1,
  fullyParallel: false,

  /* A failed test must be reported, never hidden by a retry. */
  retries: 0,

  /* 90 s per test: 60 s allowed for engine readiness + interaction budget. */
  timeout: 90_000,

  expect: {
    timeout: 15_000,
  },

  /* Fail fast-ish on CI if a test is accidentally left as test.only. */
  forbidOnly: !!process.env.CI,

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  use: {
    baseURL: DEV_SERVER_URL,
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    actionTimeout: 15_000,
    navigationTimeout: 90_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      args: CHROMIUM_ARGS,
    },
  },

  projects: [
    {
      name: 'chromium-webgl',
      use: { browserName: 'chromium' },
    },
  ],

  /*
   * Vite dev server. `reuseExistingServer: true` means a dev server an agent
   * already started by hand (e.g. for manual inspection) is reused instead of
   * starting a second one on the same port. `--strictPort` makes a port
   * collision fail loudly rather than silently moving to 5174, because the
   * capture script and the docs both assume 5173.
   */
  webServer: {
    command: `pnpm exec vite --port ${DEV_SERVER_PORT} --strictPort --host 127.0.0.1`,
    url: DEV_SERVER_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
