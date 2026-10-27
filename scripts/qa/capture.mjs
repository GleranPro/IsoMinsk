#!/usr/bin/env node
/**
 * Isometric Minsk — screenshot + stats capture (QA).
 *
 * Standalone Playwright script (no test runner). It:
 *   1. reuses a dev server already listening on http://127.0.0.1:5173, or starts
 *      one (`pnpm exec vite --port 5173 --strictPort --host 127.0.0.1`) and kills
 *      it afterwards;
 *   2. waits until the renderer reports ready through `window.__CITY_APP__`
 *      (`.ready === true`, the handle at `.app`) or `window.__CITY_STATS__`;
 *   3. captures a fixed, comparable set of screenshots into `screenshots/`;
 *   4. writes `screenshots/stats.json` (EngineStats snapshot + shot metadata) and
 *      `screenshots/console.log` (every browser console message, for evidence).
 *
 * Honesty contract: if the app never becomes ready, this script does NOT write
 * pretending screenshots. It saves whatever it can as `00-failure.png`/console
 * log and exits with code 1 and a clear message.
 *
 * Usage (PowerShell, from repo root):
 *   node scripts/qa/capture.mjs
 *   $env:QA_BASE_URL='http://127.0.0.1:5173'; node scripts/qa/capture.mjs
 *   $env:QA_HEADLESS='0'; node scripts/qa/capture.mjs   # watch it live
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SHOTS_DIR = path.join(ROOT, 'screenshots');
const PORT = Number(process.env.QA_PORT || 5173);
const EXTERNAL_URL = process.env.QA_BASE_URL?.trim() || '';
const BASE_URL = EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
const HEADLESS = process.env.QA_HEADLESS !== '0';
const READY_TIMEOUT_MS = Number(process.env.QA_READY_TIMEOUT_MS || 90_000);
const VIEWPORT = { width: 1600, height: 900 };

/** Chromium flags for deterministic software WebGL2 (see playwright.config.ts). */
const CHROMIUM_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];

// --------------------------------------------------------------------------
// dev server management
// --------------------------------------------------------------------------

/** @type {import('node:child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {string[]} */
const serverOutput = [];

async function probeServer(url, timeoutMs = 1500) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (EXTERNAL_URL) {
    const ok = await probeServer(EXTERNAL_URL);
    if (!ok) throw new Error(`QA_BASE_URL=${EXTERNAL_URL} is not reachable`);
    console.log(`[server] using external server ${EXTERNAL_URL}`);
    return;
  }

  if (await probeServer(BASE_URL)) {
    console.log(`[server] reusing dev server already listening on ${BASE_URL}`);
    return;
  }

  console.log(`[server] starting: pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`);
  serverProcess = spawn(
    'pnpm',
    ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: ROOT,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    },
  );
  serverProcess.stdout?.on('data', (chunk) => serverOutput.push(String(chunk)));
  serverProcess.stderr?.on('data', (chunk) => serverOutput.push(String(chunk)));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(
        `dev server exited with code ${serverProcess.exitCode} before becoming reachable\n${serverOutput.join('')}`,
      );
    }
    if (await probeServer(BASE_URL)) {
      console.log(`[server] dev server ready at ${BASE_URL}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`dev server did not become reachable within 120 s\n${serverOutput.join('')}`);
}

function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      serverProcess.kill('SIGTERM');
    }
    console.log('[server] stopped dev server');
  } catch (error) {
    console.warn(`[server] failed to stop dev server: ${String(error)}`);
  }
}

// --------------------------------------------------------------------------
// browser-side helpers
// --------------------------------------------------------------------------

/**
 * Reads the current app handle state and returns a readiness descriptor.
 *
 * IMPORTANT: `window.__CITY_STATS__` alone is NOT ready — the renderer emits
 * zeroed stats from its very first frame, before any tile has loaded. A real
 * readiness signal is either `__CITY_APP__.ready === true` (set on the
 * renderer's onReady callback) or stats that prove city geometry is loaded.
 */
const READY_PROBE = () => {
  const api = window.__CITY_APP__;
  const stats = window.__CITY_STATS__ ?? api?.stats ?? null;
  const hasGeometry = !!stats && stats.loadedTiles > 0 && stats.triangles > 0;
  if (api && api.ready === true && api.app) return 'city-app-ready';
  if (api && api.ready === true) return 'city-app-ready-no-handle';
  if (api && api.app && hasGeometry) return 'city-app-rendering';
  if (!api && hasGeometry) return 'stats-only-rendering';
  return false;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads the fatal-error text the renderer/UI exposes (may be visually hidden). */
async function readRendererError(page) {
  return page
    .evaluate(() => {
      const element = document.querySelector('[data-testid="error-message"]');
      return element ? (element.textContent ?? '').trim() : '';
    })
    .catch(() => '');
}

/**
 * Polls until the renderer is genuinely ready. Fails fast when the app reports
 * a fatal error (e.g. missing city data) instead of waiting out the timeout.
 */
async function waitForRendererReady(page) {
  const startedAt = Date.now();
  const deadline = startedAt + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = await page
      .evaluate(READY_PROBE)
      .catch(() => false);
    if (probe) {
      console.log(`[ready] ${probe} after ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
      return probe;
    }
    const rendererError = await readRendererError(page);
    if (rendererError) {
      throw new Error(
        `Renderer reported a fatal error after ${((Date.now() - startedAt) / 1000).toFixed(1)} s: ` +
          `"${rendererError}". The city cannot be captured until this is fixed.`,
      );
    }
    await sleep(250);
  }
  const snapshot = await page
    .evaluate(() => ({
      url: location.href,
      hasCityApp: typeof window.__CITY_APP__ !== 'undefined',
      ready: window.__CITY_APP__?.ready,
      hasAppHandle: typeof window.__CITY_APP__?.app === 'object' && window.__CITY_APP__?.app !== null,
      hasStatsGlobal: typeof window.__CITY_STATS__ !== 'undefined',
      stats: window.__CITY_STATS__ ?? window.__CITY_APP__?.stats ?? null,
      canvasCount: document.querySelectorAll('canvas').length,
    }))
    .catch(() => null);
  const rendererError = await readRendererError(page);
  throw new Error(
    `Renderer did not become ready within ${Math.round(READY_TIMEOUT_MS / 1000)} s.\n` +
      `Snapshot: ${JSON.stringify(snapshot, null, 2)}\n` +
      `Renderer error overlay: ${rendererError || '(none)'}`,
  );
}

/**
 * After readiness, insists that actual city geometry is on screen. The renderer
 * can be "ready" while no tile mesh was created; screenshots of an empty scene
 * are worthless for QA, so treat that as a failure. The threshold (> 5000
 * triangles) is a deliberately low sanity floor, not the e2e geometry budget.
 */
async function waitForRenderedGeometry(page) {
  const deadline = Date.now() + 60_000;
  let stats = null;
  while (Date.now() < deadline) {
    stats = await readStats(page);
    if (stats && stats.loadedTiles > 0 && stats.triangles > 5000) {
      console.log(
        `[geometry] ${stats.triangles} triangles, ${stats.buildings} buildings, ${stats.loadedTiles} tiles loaded`,
      );
      if (stats.buildings <= 100) {
        console.warn(
          `[warn] only ${stats.buildings} buildings reported (e2e expects > 100) — continuing, but this is suspicious`,
        );
      }
      return stats;
    }
    const rendererError = await readRendererError(page);
    if (rendererError) {
      throw new Error(`Renderer reported a fatal error while loading tiles: "${rendererError}"`);
    }
    await sleep(500);
  }
  throw new Error(
    `The city never rendered > 5000 triangles within 60 s (last stats=${JSON.stringify(stats)}). ` +
      'Screenshots of an empty/degenerate scene would be misleading, so capture aborted.',
  );
}

/** Calls a CityAppHandle method through window.__CITY_APP__.app. */
async function callApp(page, method, ...args) {
  return page.evaluate(
    ({ methodName, methodArgs }) => {
      const handle = window.__CITY_APP__?.app;
      if (!handle || typeof handle[methodName] !== 'function') {
        return { ok: false, reason: 'CityAppHandle method is not exposed (window.__CITY_APP__.app)' };
      }
      try {
        return { ok: true, value: handle[methodName](...methodArgs) };
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
    },
    { methodName: method, methodArgs: args },
  );
}

/** Best-effort wait for two frames + a short settle so the canvas is fresh. */
async function settle(page, ms = 500) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)));
      }),
  );
  await page.waitForTimeout(ms);
}

/** Reads EngineStats from whichever global the renderer exposes. */
async function readStats(page) {
  return page.evaluate(() => {
    const api = window.__CITY_APP__;
    if (api?.stats && typeof api.stats === 'object') return api.stats;
    if (window.__CITY_STATS__ && typeof window.__CITY_STATS__ === 'object') return window.__CITY_STATS__;
    try {
      return api?.app?.getStats?.() ?? null;
    } catch {
      return null;
    }
  });
}

async function readCamera(page) {
  const result = await callApp(page, 'getCameraSettings');
  return result.ok ? result.value : null;
}

async function readTimeOfDay(page) {
  const result = await callApp(page, 'getTimeOfDay');
  return result.ok ? result.value : null;
}

async function readPixelEffect(page) {
  const result = await callApp(page, 'isPixelEffectEnabled');
  return result.ok ? result.value : null;
}

/**
 * Finds candidate buildings from the real generated tile data (fetched in the
 * page, so it goes through the same dev-server URLs the renderer uses).
 *
 * Returns:
 *   residential — nearest khrushchev/panel block to the data centre,
 *   landmark    — tallest building within ~650 m of the centre (October Square).
 */
async function findFocusTargets(page) {
  return page.evaluate(async () => {
    const manifestResponse = await fetch('/data/tiles/manifest.json');
    if (!manifestResponse.ok) return { error: `manifest HTTP ${manifestResponse.status}` };
    const contentType = manifestResponse.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      return {
        error:
          `manifest request returned content-type "${contentType}" instead of JSON — ` +
          'public/data/tiles has not been generated yet (the dev server serves index.html as a fallback)',
      };
    }
    let manifest;
    try {
      manifest = await manifestResponse.json();
    } catch (error) {
      return { error: `manifest is not valid JSON: ${String(error)}` };
    }
    if (!manifest || !Array.isArray(manifest.tiles) || manifest.tiles.length === 0) {
      return { error: 'manifest has no tiles' };
    }
    const bounds = manifest.bounds;
    const centre = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    const buildings = [];
    for (const entry of manifest.tiles) {
      let data;
      try {
        const response = await fetch(`/data/${entry.file}`);
        if (!response.ok) continue;
        data = await response.json();
      } catch {
        continue;
      }
      for (const building of data.buildings ?? []) {
        const ring = building.volumes?.[0]?.footprint?.[0];
        if (!Array.isArray(ring) || ring.length < 3) continue;
        let cx = 0;
        let cy = 0;
        for (const point of ring) {
          cx += point[0];
          cy += point[1];
        }
        cx /= ring.length;
        cy /= ring.length;
        const distance = Math.hypot(cx - centre[0], cy - centre[1]);
        buildings.push({
          id: building.id,
          archetype: building.archetype,
          height: building.height,
          name: building.name ?? '',
          x: cx,
          y: cy,
          distance,
        });
      }
    }
    if (buildings.length === 0) return { error: 'no buildings in tiles' };

    const residentialCandidates = buildings.filter(
      (b) => ['khrushchev', 'panel'].includes(b.archetype) && b.height >= 8 && b.height <= 60,
    );
    const residential = (residentialCandidates.length ? residentialCandidates : buildings)
      .slice()
      .sort((a, b) => a.distance - b.distance)[0];

    const nearCentre = buildings.filter((b) => b.distance <= 650);
    const landmark = (nearCentre.length ? nearCentre : buildings)
      .slice()
      .sort((a, b) => b.height - a.height)[0];

    return {
      centre,
      counts: { buildings: buildings.length, tiles: manifest.tiles.length },
      residential,
      landmark,
    };
  });
}

/** Fallback when window.__CITY_APP__.app is missing: drive the same controls with the mouse/keyboard. */
async function canvasCenter(page) {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function inputWheelZoom(page, deltaY) {
  const { x, y } = await canvasCenter(page);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, deltaY);
  await settle(page);
}

async function inputPan(page, dx, dy) {
  const { x, y } = await canvasCenter(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
  await settle(page);
}

async function inputRotateDrag(page, dx) {
  const { x, y } = await canvasCenter(page);
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + dx, y, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await settle(page);
}

async function inputSetTimeOfDay(page, hours) {
  // React controlled <input type="range">: use the native value setter + events.
  const changed = await page
    .evaluate((value) => {
      const slider = document.querySelector('[data-testid="time-slider"]');
      if (!(slider instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(slider, String(value));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, hours)
    .catch(() => false);
  return changed;
}

async function inputTogglePixel(page) {
  const toggle = page.locator('[data-testid="toggle-pixel"]');
  if ((await toggle.count()) === 0) return false;
  await toggle.click();
  return true;
}

// --------------------------------------------------------------------------
// capture flow
// --------------------------------------------------------------------------

/** @type {Array<Record<string, unknown>>} */
const shotMeta = [];
/** @type {Array<{ type: string, text: string }>} */
const consoleMessages = [];
/** @type {string[]} */
const consoleErrors = [];
/** @type {string[]} */
const pageErrors = [];

async function captureShot(page, file, note, setup) {
  const setupResult = await setup();
  await settle(page);
  const camera = await readCamera(page);
  const timeOfDay = await readTimeOfDay(page);
  const pixelEffect = await readPixelEffect(page);
  await page.screenshot({ path: path.join(SHOTS_DIR, file), fullPage: false });
  shotMeta.push({ file, note, camera, timeOfDay, pixelEffect, setup: setupResult ?? 'ok' });
  console.log(`[shot] ${file}  camera=${JSON.stringify(camera)} tod=${timeOfDay} pixel=${pixelEffect}`);
}

async function run() {
  await mkdir(SHOTS_DIR, { recursive: true });

  let browser = null;
  let exitCode = 0;
  let failureMessage = '';

  try {
    await ensureServer();

    browser = await chromium.launch({ headless: HEADLESS, args: CHROMIUM_ARGS });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    page.on('console', (message) => {
      const entry = { type: message.type(), text: message.text() };
      consoleMessages.push(entry);
      if (entry.type === 'error') consoleErrors.push(entry.text);
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.stack || String(error));
      console.error(`[pageerror] ${error.message}`);
    });
    page.on('requestfailed', (request) => {
      consoleMessages.push({
        type: 'requestfailed',
        text: `${request.url()} — ${request.failure()?.errorText ?? 'unknown error'}`,
      });
    });

    console.log(`[browser] navigating to ${BASE_URL}`);
    const response = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    if (!response || !response.ok()) {
      throw new Error(`page.goto returned HTTP ${response?.status() ?? 'no response'}`);
    }

    // Renderer readiness — hard requirement, fail loudly if it never happens.
    let readyStatus;
    try {
      readyStatus = await waitForRendererReady(page);
    } catch (error) {
      failureMessage = String(error);
      await page.screenshot({ path: path.join(SHOTS_DIR, '00-failure.png') }).catch(() => {});
      throw error;
    }

    // "Ready" must mean the city is actually on screen, not an empty sky.
    try {
      await waitForRenderedGeometry(page);
    } catch (error) {
      failureMessage = String(error);
      await page.screenshot({ path: path.join(SHOTS_DIR, '00-failure.png') }).catch(() => {});
      throw error;
    }

    const appApiAvailable = await page.evaluate(
      () => typeof window.__CITY_APP__?.app?.getCameraSettings === 'function',
    );
    if (!appApiAvailable) {
      console.warn(
        '[warn] window.__CITY_APP__.app (CityAppHandle) is NOT exposed — falling back to mouse/keyboard input. ' +
          'Camera/time-of-day/pixel values in stats.json will be null where the API was required.',
      );
    }

    const focusTargets = await findFocusTargets(page).catch((error) => ({ error: String(error) }));
    if (focusTargets.error) {
      console.warn(`[warn] could not derive focus targets from tile data: ${focusTargets.error}`);
    } else {
      console.log(
        `[data] ${focusTargets.counts.buildings} buildings in ${focusTargets.counts.tiles} tiles; ` +
          `residential=${focusTargets.residential?.archetype} (${focusTargets.residential?.height} m), ` +
          `landmark=${focusTargets.landmark?.archetype} (${focusTargets.landmark?.height} m)`,
      );
    }

    // 01 — default isometric view of the whole district.
    await captureShot(page, '01-overview.png', 'default isometric view of the pilot district', async () => {
      if (appApiAvailable) {
        await callApp(page, 'resetCamera');
        await callApp(page, 'setTimeOfDay', 13);
        await callApp(page, 'setPixelEffectEnabled', true);
        const camera = await readCamera(page);
        console.log(`[camera] overview orthoHeight=${camera?.orthoHeight}`);
      } else {
        await page.keyboard.press('Escape');
      }
      return 'resetCamera + time 13:00 + pixel art on';
    });

    // 02 — close-up of a residential panel / Khrushchev block.
    await captureShot(page, '02-closeup-residential.png', 'close-up: residential panel/Khrushchev block', async () => {
      const target = focusTargets.residential;
      if (appApiAvailable && target) {
        await callApp(page, 'focusOnLocal', target.x, target.y);
        await callApp(page, 'setCameraSettings', { orthoHeight: 110 });
        return `focusOnLocal(${target.x.toFixed(1)}, ${target.y.toFixed(1)}) archetype=${target.archetype}`;
      }
      await inputWheelZoom(page, -900);
      return 'fallback: wheel zoom in at canvas centre';
    });

    // 03 — close-up of a large central building near October Square.
    await captureShot(page, '03-closeup-landmark.png', 'close-up: large landmark building near October Square', async () => {
      const target = focusTargets.landmark;
      if (appApiAvailable && target) {
        await callApp(page, 'focusOnLocal', target.x, target.y);
        await callApp(page, 'setCameraSettings', { orthoHeight: 170 });
        return `focusOnLocal(${target.x.toFixed(1)}, ${target.y.toFixed(1)}) height=${target.height} m archetype=${target.archetype}`;
      }
      await inputPan(page, 0, 0);
      return 'fallback: no focus API';
    });

    // 04 — night preset.
    await captureShot(page, '04-night.png', 'night lighting preset (23:00) from the default view', async () => {
      if (appApiAvailable) {
        await callApp(page, 'resetCamera');
        await callApp(page, 'setTimeOfDay', 23);
        return 'resetCamera + setTimeOfDay(23)';
      }
      await inputSetTimeOfDay(page, 23);
      return 'fallback: time slider set to 23:00';
    });

    // 05 — pixel effect off, for inspecting raw geometry.
    await captureShot(page, '05-clean-3d.png', 'pixel-art post-effect disabled (clean 3D) from the default view', async () => {
      if (appApiAvailable) {
        await callApp(page, 'resetCamera');
        await callApp(page, 'setTimeOfDay', 13);
        await callApp(page, 'setPixelEffectEnabled', false);
        return 'setTimeOfDay(13) + setPixelEffectEnabled(false)';
      }
      await inputSetTimeOfDay(page, 13);
      await inputTogglePixel(page);
      return 'fallback: toggle pixel-art checkbox';
    });

    // 06 — 90-degree rotated view.
    await captureShot(page, '06-rotated.png', 'default view rotated 90 degrees in azimuth', async () => {
      if (appApiAvailable) {
        await callApp(page, 'setPixelEffectEnabled', true);
        await callApp(page, 'resetCamera');
        const camera = await readCamera(page);
        const baseAzimuth = camera?.azimuth ?? Math.PI / 4;
        await callApp(page, 'setCameraSettings', { azimuth: baseAzimuth + Math.PI / 2 });
        return `azimuth ${baseAzimuth.toFixed(3)} -> ${(baseAzimuth + Math.PI / 2).toFixed(3)} rad`;
      }
      await inputRotateDrag(page, -400);
      return 'fallback: right-drag rotation';
    });

    // Restore a sane interactive state for anyone looking at the live browser.
    if (appApiAvailable) {
      await callApp(page, 'resetCamera');
      await callApp(page, 'setTimeOfDay', 13);
      await callApp(page, 'setPixelEffectEnabled', true);
    }

    const engineStats = await readStats(page);
    const rendererError = await readRendererError(page);
    const finalCamera = await readCamera(page);
    const finalTimeOfDay = await readTimeOfDay(page);
    const finalPixelEffect = await readPixelEffect(page);
    const loadingOverlayClass = await page
      .locator('[data-testid="loading-overlay"]')
      .evaluate((element) => element.className, { timeout: 1500 })
      .catch(() => null);

    const report = {
      capturedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      viewport: VIEWPORT,
      readyStatus,
      appApiExposed: appApiAvailable,
      statsSource: appApiAvailable ? 'window.__CITY_APP__.stats / getStats()' : 'window.__CITY_STATS__',
      engineStats,
      rendererError,
      finalCamera,
      finalTimeOfDay,
      finalPixelEffect,
      loadingOverlayClass,
      focusTargets: focusTargets.error ? { error: focusTargets.error } : focusTargets,
      screenshots: shotMeta,
      console: {
        errors: consoleErrors,
        totalMessages: consoleMessages.length,
        messages: consoleMessages,
      },
      pageErrors,
    };
    await writeFile(path.join(SHOTS_DIR, 'stats.json'), JSON.stringify(report, null, 2), 'utf8');
    await writeFile(
      path.join(SHOTS_DIR, 'console.log'),
      [...consoleMessages.map((m) => `[${m.type}] ${m.text}`), ...pageErrors.map((e) => `[pageerror] ${e}`)].join(
        '\n',
      ),
      'utf8',
    );

    if (!engineStats) {
      throw new Error(
        'EngineStats were not available from window.__CITY_APP__.stats, window.__CITY_STATS__ or app.getStats() — ' +
          'cannot report performance numbers.',
      );
    }

    console.log('\n[stats]', JSON.stringify(engineStats));
    console.log(`[console] ${consoleMessages.length} messages, ${consoleErrors.length} errors, ${pageErrors.length} page errors`);
    console.log(`\nSaved ${shotMeta.length} screenshots + stats.json to ${SHOTS_DIR}`);
  } catch (error) {
    exitCode = 1;
    failureMessage = failureMessage || (error instanceof Error ? error.message : String(error));
    console.error(`\n[FAIL] ${failureMessage}`);

    // Make sure the evidence files exist even when capture died early.
    try {
      const consoleText = [
        ...consoleMessages.map((m) => `[${m.type}] ${m.text}`),
        ...pageErrors.map((e) => `[pageerror] ${e}`),
        `[fatal] ${failureMessage}`,
      ].join('\n');
      await writeFile(path.join(SHOTS_DIR, 'console.log'), consoleText, 'utf8');
      await writeFile(
        path.join(SHOTS_DIR, 'stats.json'),
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            failed: true,
            failureMessage,
            readyStatus: null,
            engineStats: null,
            screenshots: shotMeta,
            pageErrors,
            console: { errors: consoleErrors, totalMessages: consoleMessages.length },
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      /* best effort only */
    }
  } finally {
    await browser?.close().catch(() => {});
    stopServer();
  }

  if (exitCode !== 0) {
    console.error(`\nCapture failed: ${failureMessage}`);
    process.exit(exitCode);
  }
}

await run();
