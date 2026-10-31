#!/usr/bin/env node
/**
 * Isometric Minsk — road-focused screenshot sweep (QA, payload 0.2.0).
 *
 * Captures deterministic close-ups of the normalized road network introduced by
 * the 0.2.0 rewrite: junction boxes, material zones (asphalt vs stone), lane
 * markings, zebra crossings, kerbs/medians, tile boundaries and the night
 * preset. All camera targets are fixed local-metre coordinates derived from the
 * generated pilot payload (crossing-dense junctions of Independence Avenue,
 * Karl Marx / Yanka Kupala, Nemiga and Gorodskoy Val); the script also checks
 * that a junction/crossing exists near each target and warns if the data moved.
 *
 * A `pnpm dev` server is expected (the script reuses whatever is listening on
 * http://127.0.0.1:5173, or starts `pnpm exec vite --port 5173 --strictPort
 * --host 127.0.0.1` itself and stops it afterwards — same pattern as
 * scripts/qa/capture.mjs). The app is driven through the public
 * `window.__CITY_APP__.app` CityAppHandle: focusOnLocal + setCameraSettings
 * (orthoHeight), setTimeOfDay and setPixelEffectEnabled. The old
 * `?fx=&fy=&zoom=&time=&pixel=` QA URL parameters are NOT used — the current
 * engine does not parse them.
 *
 * Exact command (PowerShell, repo root):
 *   pnpm dev                         # terminal 1 — expected, serves port 5173
 *   node scripts/qa/road-shots.mjs   # terminal 2
 *
 * Optional environment variables (same conventions as capture.mjs):
 *   QA_GPU=1            # hardware GPU (ANGLE/D3D11) instead of SwiftShader
 *   QA_HEADLESS=0       # show the browser window
 *   QA_BASE_URL=...     # attach to an existing server instead of 127.0.0.1:5173
 *   QA_PORT=5174        # start/reuse a different port
 *   QA_READY_TIMEOUT_MS=120000
 *   QA_ONLY=<substring> # capture only matching shot files, e.g. QA_ONLY=night
 *
 * Output: `screenshots/roads/*.png` (12 shots), `screenshots/roads/shots.json`
 * (per-shot camera/time/pixel/stats evidence) and `screenshots/roads/console.log`.
 * Honesty contract: if the renderer never becomes ready or the full city never
 * streams in, no misleading screenshots are kept as success — the script writes
 * `00-failure.png` + metadata and exits 1. It also exits 1 if the browser reports
 * console/page errors during the sweep (the shots are still written for triage).
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SHOTS_DIR = path.join(ROOT, 'screenshots', 'roads');
const DATA_DIR = path.join(ROOT, 'public', 'data', 'tiles');
const PORT = Number(process.env.QA_PORT || 5173);
const EXTERNAL_URL = process.env.QA_BASE_URL?.trim() || '';
const BASE_URL = EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
const HEADLESS = process.env.QA_HEADLESS !== '0';
const READY_TIMEOUT_MS = Number(process.env.QA_READY_TIMEOUT_MS || 120_000);
const VIEWPORT = { width: 1600, height: 900 };

/** Chromium flags for deterministic software WebGL2 (see playwright.config.ts). */
const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];
/** Hardware GPU (`QA_GPU=1`): ANGLE/D3D11 in headless Chromium. */
const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
const USE_GPU = process.env.QA_GPU === '1';
const CHROMIUM_ARGS = USE_GPU ? GPU_ARGS : SWIFTSHADER_ARGS;

/** Default isometric view settings (src/shared/config.ts ISO_CAMERA). */
const ISO_AZIMUTH = Math.PI / 4;
const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);

/**
 * Fixed, deterministic shot list.
 *
 * Coordinates are LOCAL METRES in the UTM-35N local frame (0, 0 = pilot centre,
 * October Square). `fx`/`fy` are the camera focus; `zoom` is the orthographic
 * vertical half-extent in metres (smaller = closer); `time` is the lighting hour;
 * `pixel` 1 = pixel-art post pass, 0 = clean 3D.
 *
 * Target derivation (current generated payload):
 *   (a) Independence Ave × Yanka Kupala junction  = (355.2, 231.4), junction r=14.2
 *   (b) Karl Marx × Yanka Kupala: junction at (465.4, 90.5), r=8.2; the shot is framed
 *       at (420, 50) so the sett/cobblestone zone and the short asphalt apron meet in view
 *   (c) Nemiga junction area (Nemiga × Pobediteley) = (-492, 334), nearest junction (-514.9, 323.1)
 *   (d) Gorodskoy Val × Independence Ave = (-480.2, -477.4), junction r=13.9
 *   (f) tile boundary x = 0 crossed by Independence Ave = (0, -75)
 *   (g) far overview = resetCamera + orthoHeight 900 m
 *   (+1) zebra-crossing cluster at (-258.5, -501.5): five zebra crossings in one junction
 *   (13 shots total; at least the 8 required views a–h are present)
 */
const SHOTS = [
  {
    file: '01-independence-yanka-junction-pixel.png',
    note: 'Independence Ave × Yanka Kupala junction: material zones, junction box, lane markings and stop lines',
    fx: 355.2,
    fy: 231.4,
    zoom: 95,
    time: 13,
    pixel: 1,
  },
  {
    file: '02-karl-marx-yanka-stone-pixel.png',
    note: 'Karl Marx × Yanka Kupala: stone sett/cobblestone zone meets the long asphalt continuation',
    fx: 420,
    fy: 50,
    zoom: 110,
    time: 13,
    pixel: 1,
  },
  {
    file: '03-karl-marx-yanka-stone-clean.png',
    note: 'same Karl Marx material boundary without the pixel post pass (surface geometry review)',
    fx: 420,
    fy: 50,
    zoom: 110,
    time: 13,
    pixel: 0,
  },
  {
    file: '04-nemiga-junction-pixel.png',
    note: 'Nemiga junction (Nemiga × Pobediteley) with the Svislach crossing context',
    fx: -492,
    fy: 334,
    zoom: 95,
    time: 13,
    pixel: 1,
  },
  {
    file: '05-gorodskoy-val-junction-pixel.png',
    note: 'Gorodskoy Val × Independence Ave junction (south-west of the pilot centre)',
    fx: -480.2,
    fy: -477.4,
    zoom: 90,
    time: 13,
    pixel: 1,
  },
  {
    file: '06-night-junction.png',
    note: 'Independence Ave × Yanka Kupala junction at night (23:00); markings still readable',
    fx: 355.2,
    fy: 231.4,
    zoom: 95,
    time: 23,
    pixel: 1,
  },
  {
    file: '07-tile-boundary-closeup.png',
    note: 'tile-boundary close-up at x = 0: Independence Ave crossing the 512 m tile seam',
    fx: 0,
    fy: -75,
    zoom: 70,
    time: 13,
    pixel: 1,
  },
  {
    file: '08-far-overview.png',
    note: 'far overview of the whole pilot from the default isometric camera (orthoHeight 900 m)',
    reset: true,
    zoom: 900,
    time: 13,
    pixel: 1,
  },
  {
    file: '09-clean-3d-junction.png',
    note: 'clean-3D variant of the main junction without the pixel-art post pass',
    fx: 355.2,
    fy: 231.4,
    zoom: 95,
    time: 13,
    pixel: 0,
  },
  {
    file: '10-junction-closeup-pixel.png',
    note: 'very close junction box: stop lines, zebra bars and lane divider ends',
    fx: 355.2,
    fy: 231.4,
    zoom: 45,
    time: 13,
    pixel: 1,
  },
  {
    file: '11-nemiga-clean.png',
    note: 'Nemiga junction, clean 3D',
    fx: -492,
    fy: 334,
    zoom: 95,
    time: 13,
    pixel: 0,
  },
  {
    file: '12-night-overview.png',
    note: 'night overview (23:00) for lighting sanity across the whole pilot',
    reset: true,
    zoom: 900,
    time: 23,
    pixel: 1,
  },
  {
    file: '13-zebra-crossings-pixel.png',
    note: 'crossing-dense junction with five zebra crossings (zebra bars + stop lines derived from roadNetwork)',
    fx: -258.5,
    fy: -501.5,
    zoom: 70,
    time: 13,
    pixel: 1,
  },
];

// --------------------------------------------------------------------------
// dev server management (same pattern as scripts/qa/capture.mjs)
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
// payload-derived target sanity (read the same files the dev server serves)
// --------------------------------------------------------------------------

/**
 * Finds the nearest junction/crossing to every fixed target so the shot list is
 * verifiably anchored in the generated payload. Not fatal: if the pipeline moves
 * a junction we warn instead of silently framing an empty patch of ground.
 */
async function checkShotTargets() {
  try {
    const manifest = JSON.parse(await readFile(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
    const junctions = [];
    const crossings = [];
    for (const entry of manifest.tiles ?? []) {
      const data = JSON.parse(await readFile(path.join(DATA_DIR, path.basename(entry.file)), 'utf8'));
      for (const junction of data.junctions ?? []) junctions.push(junction);
      for (const crossing of data.crossings ?? []) crossings.push(crossing);
    }
    for (const shot of SHOTS) {
      if (!Number.isFinite(shot.fx) || !Number.isFinite(shot.fy)) continue;
      const nearest = (items) => {
        let best = null;
        for (const item of items) {
          const distance = Math.hypot(item.x - shot.fx, item.y - shot.fy);
          if (!best || distance < best.distance) best = { item, distance };
        }
        return best;
      };
      const junction = nearest(junctions);
      const crossing = nearest(crossings);
      const junctionText = junction
        ? `nearest junction (${junction.item.x}, ${junction.item.y}) r=${junction.item.radius} at ${junction.distance.toFixed(0)} m`
        : 'no junctions';
      const crossingText = crossing
        ? `nearest crossing (${crossing.item.x}, ${crossing.item.y}) ${crossing.item.kind} at ${crossing.distance.toFixed(0)} m`
        : 'no crossings';
      console.log(`[target] ${shot.file}: ${junctionText}; ${crossingText}`);
      if (!junction || junction.distance > 80) {
        console.warn(`[target][warn] ${shot.file}: no junction within 80 m of the fixed target`);
      }
    }
  } catch (error) {
    console.warn(`[target][warn] could not cross-check shot targets against the payload: ${String(error)}`);
  }
}

// --------------------------------------------------------------------------
// browser-side helpers (mirrors scripts/qa/capture.mjs)
// --------------------------------------------------------------------------

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

async function readRendererError(page) {
  return page
    .evaluate(() => {
      const element = document.querySelector('[data-testid="error-message"]');
      return element ? (element.textContent ?? '').trim() : '';
    })
    .catch(() => '');
}

async function waitForRendererReady(page) {
  const startedAt = Date.now();
  const deadline = startedAt + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = await page.evaluate(READY_PROBE).catch(() => false);
    if (probe) {
      console.log(`[ready] ${probe} after ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
      return probe;
    }
    const rendererError = await readRendererError(page);
    if (rendererError) {
      throw new Error(`Renderer reported a fatal error: "${rendererError}"`);
    }
    await sleep(250);
  }
  throw new Error(`Renderer did not become ready within ${Math.round(READY_TIMEOUT_MS / 1000)} s`);
}

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

/** Requires every manifest tile resident (same gate as capture.mjs). */
async function waitForRenderedGeometry(page) {
  const deadline = Date.now() + 120_000;
  let stats = null;
  let lastSignature = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    stats = await readStats(page);
    if (stats && stats.loadedTiles > 0 && stats.triangles > 5000) {
      const expectedTiles = await page
        .evaluate(async () => {
          try {
            const response = await fetch('/data/tiles/manifest.json');
            if (!response.ok) return 0;
            const manifest = await response.json();
            return Array.isArray(manifest.tiles) ? manifest.tiles.length : 0;
          } catch {
            return 0;
          }
        })
        .catch(() => 0);
      if (expectedTiles > 0 && stats.loadedTiles >= expectedTiles) {
        console.log(
          `[geometry] ${stats.triangles} triangles, ${stats.buildings} buildings, ` +
            `${stats.loadedTiles}/${expectedTiles} tiles loaded`,
        );
        return stats;
      }
      if (expectedTiles === 0) {
        const signature = `${stats.loadedTiles}/${Math.round(stats.triangles / 1000)}`;
        if (signature === lastSignature) {
          if (Date.now() - stableSince > 2000) {
            console.log(`[geometry] stats stable (manifest unavailable): ${JSON.stringify(stats)}`);
            return stats;
          }
        } else {
          lastSignature = signature;
          stableSince = Date.now();
        }
      }
    }
    const rendererError = await readRendererError(page);
    if (rendererError) {
      throw new Error(`Renderer reported a fatal error while loading tiles: "${rendererError}"`);
    }
    await sleep(500);
  }
  throw new Error(
    `The city never finished streaming within 120 s (last stats=${JSON.stringify(stats)}); ` +
      'refusing to capture misleading partial-city screenshots.',
  );
}

async function readWebglRenderer(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    if (!gl) return 'no-webgl2-context';
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
}

/** Two animation frames + a settle delay so the canvas is fresh. */
async function settle(page, ms = 700) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80)));
      }),
  );
  await page.waitForTimeout(ms);
}

/** Applies one deterministic shot through the CityAppHandle. */
async function applyShot(page, shot) {
  return page.evaluate(
    ({ shot: spec, isoAzimuth, isoElevation }) => {
      const api = window.__CITY_APP__;
      const app = api?.app;
      if (!app) return { ok: false, reason: 'window.__CITY_APP__.app (CityAppHandle) is not exposed' };
      try {
        if (spec.reset) app.resetCamera();
        if (Number.isFinite(spec.fx) && Number.isFinite(spec.fy)) app.focusOnLocal(spec.fx, spec.fy);
        app.setCameraSettings({
          orthoHeight: spec.zoom,
          azimuth: isoAzimuth,
          elevation: isoElevation,
        });
        app.setTimeOfDay(spec.time);
        app.setPixelEffectEnabled(spec.pixel === 1);
        return {
          ok: true,
          camera: app.getCameraSettings(),
          timeOfDay: app.getTimeOfDay(),
          pixelEffect: app.isPixelEffectEnabled(),
        };
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
    },
    { shot, isoAzimuth: ISO_AZIMUTH, isoElevation: ISO_ELEVATION },
  );
}

// --------------------------------------------------------------------------
// capture flow
// --------------------------------------------------------------------------

/** @type {Array<{ type: string, text: string }>} */
const consoleMessages = [];
/** @type {string[]} */
const consoleErrors = [];
/** @type {string[]} */
const pageErrors = [];

/** @type {Array<Record<string, unknown>>} */
const shotMeta = [];

async function captureShot(page, shot, index) {
  const applied = await applyShot(page, shot);
  if (!applied.ok) {
    throw new Error(`Could not apply shot ${shot.file}: ${applied.reason}`);
  }
  await settle(page);
  // Let the camera controller and streamer finish their instant-move frames.
  await settle(page, 300);
  const stats = await readStats(page);
  const file = path.join(SHOTS_DIR, shot.file);
  await page.screenshot({ path: file, fullPage: false });
  const meta = {
    index: index + 1,
    file: shot.file,
    note: shot.note,
    target: Number.isFinite(shot.fx) ? { x: shot.fx, y: shot.fy } : 'default-camera-centre',
    orthoHeight: shot.zoom,
    timeOfDay: shot.time,
    pixelEffect: shot.pixel === 1,
    appliedCamera: applied.camera,
    appliedTimeOfDay: applied.timeOfDay,
    appliedPixelEffect: applied.pixelEffect,
    stats,
  };
  shotMeta.push(meta);
  console.log(
    `[shot] ${shot.file}  focus=${meta.target === 'default-camera-centre' ? 'default' : `(${shot.fx}, ${shot.fy})`} ` +
      `zoom=${shot.zoom} tod=${applied.timeOfDay} pixel=${applied.pixelEffect} ` +
      `tiles=${stats?.loadedTiles ?? '?'} tris=${stats?.triangles ?? '?'} draws=${stats?.drawCalls ?? '?'}`,
  );
}

async function run() {
  await mkdir(SHOTS_DIR, { recursive: true });

  const only = process.env.QA_ONLY?.trim();
  const shots = only ? SHOTS.filter((shot) => shot.file.includes(only)) : SHOTS;
  if (shots.length === 0) throw new Error(`QA_ONLY="${only}" matched no shot`);

  let browser = null;
  let exitCode = 0;
  let failureMessage = '';

  try {
    await checkShotTargets();
    await ensureServer();

    browser = await chromium.launch({ headless: HEADLESS, args: CHROMIUM_ARGS });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
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

    let readyStatus;
    try {
      readyStatus = await waitForRendererReady(page);
      await waitForRenderedGeometry(page);
    } catch (error) {
      failureMessage = String(error);
      await page.screenshot({ path: path.join(SHOTS_DIR, '00-failure.png') }).catch(() => {});
      throw error;
    }

    const appApiAvailable = await page.evaluate(
      () => typeof window.__CITY_APP__?.app?.focusOnLocal === 'function',
    );
    if (!appApiAvailable) {
      throw new Error(
        'window.__CITY_APP__.app (CityAppHandle) is not exposed — cannot set deterministic road-shot ' +
          'cameras. The old QA URL parameters (?fx/fy/zoom/time/pixel) are no longer supported.',
      );
    }
    const webglRenderer = await readWebglRenderer(page);
    console.log(
      `[gpu] WebGL renderer: ${webglRenderer} ` +
        `(capture mode: ${USE_GPU ? 'hardware GPU (QA_GPU=1)' : 'SwiftShader software'})`,
    );

    for (let index = 0; index < shots.length; index += 1) {
      await captureShot(page, shots[index], index);
    }

    // Restore a sane interactive state for anyone looking at the live browser.
    await page.evaluate(() => {
      const app = window.__CITY_APP__?.app;
      if (!app) return;
      app.setPixelEffectEnabled(true);
      app.setTimeOfDay(13);
      app.resetCamera();
    });

    const engineStats = await readStats(page);
    const rendererError = await readRendererError(page);
    const report = {
      capturedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      viewport: VIEWPORT,
      readyStatus,
      appApiExposed: appApiAvailable,
      captureMode: USE_GPU ? 'hardware-gpu' : 'swiftshader-software',
      webglRenderer,
      rendererError,
      engineStats,
      screenshots: shotMeta,
      console: {
        errors: consoleErrors,
        totalMessages: consoleMessages.length,
        messages: consoleMessages,
      },
      pageErrors,
    };
    await writeFile(path.join(SHOTS_DIR, 'shots.json'), JSON.stringify(report, null, 2), 'utf8');
    await writeFile(
      path.join(SHOTS_DIR, 'console.log'),
      [...consoleMessages.map((message) => `[${message.type}] ${message.text}`), ...pageErrors.map((error) => `[pageerror] ${error}`)].join(
        '\n',
      ),
      'utf8',
    );

    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      console.error(
        `[FAIL] ${consoleErrors.length} console error(s) and ${pageErrors.length} page error(s) during the sweep; ` +
          `shots + shots.json are written for triage.`,
      );
      exitCode = 1;
    } else {
      console.log('\n[ok] no console/page errors');
    }
    console.log(`\nSaved ${shotMeta.length} road screenshots + shots.json to ${SHOTS_DIR}`);
  } catch (error) {
    exitCode = 1;
    failureMessage = failureMessage || (error instanceof Error ? error.message : String(error));
    console.error(`\n[FAIL] ${failureMessage}`);
    try {
      await writeFile(
        path.join(SHOTS_DIR, 'shots.json'),
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            failed: true,
            failureMessage,
            screenshots: shotMeta,
            pageErrors,
            console: { errors: consoleErrors, totalMessages: consoleMessages.length },
          },
          null,
          2,
        ),
        'utf8',
      );
      await writeFile(
        path.join(SHOTS_DIR, 'console.log'),
        [
          ...consoleMessages.map((message) => `[${message.type}] ${message.text}`),
          ...pageErrors.map((error) => `[pageerror] ${error}`),
          `[fatal] ${failureMessage}`,
        ].join('\n'),
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
    if (failureMessage) console.error(`\nRoad screenshot sweep failed: ${failureMessage}`);
    process.exit(exitCode);
  }
}

await run();
