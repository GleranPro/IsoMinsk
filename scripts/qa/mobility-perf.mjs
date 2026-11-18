#!/usr/bin/env node
/**
 * Isometric Minsk — mobility performance harness (QA).
 *
 * Measures fixed camera views of the running app and reports frame-time
 * percentiles, renderer counters and simulated-mobility cost. It is the
 * measurement tool behind `docs/mobility/REVIEW.md`: every off/on comparison in
 * that document must be reproducible with two invocations of this script.
 *
 * Honesty contract (same as scripts/qa/capture.mjs):
 *   - it never writes a "result" for a view that never became ready;
 *   - it records the actual WebGL backend so software and hardware numbers are
 *     never mixed;
 *   - `--mobility=on` fails loudly when the app has no mobility API instead of
 *     silently measuring the off state twice.
 *
 * Usage (PowerShell, from the repo root):
 *   node scripts/qa/mobility-perf.mjs --dataset=central --mobility=off
 *   node scripts/qa/mobility-perf.mjs --dataset=city --mobility=on --out=screenshots/perf-city-on.json
 *   $env:QA_GPU='1'; node scripts/qa/mobility-perf.mjs        # hardware GPU
 *
 * Flags:
 *   --dataset=central|city   dataset query parameter (default central)
 *   --mobility=off|on        toggle the mobility layer through the app API
 *   --views=a,b              subset of the named views below
 *   --samples=5              seconds of frame sampling per view
 *   --warmup=3               seconds to settle before sampling
 *   --out=path.json          result file (default screenshots/mobility-perf-<dataset>-<mobility>.json)
 *   --port=5173              dev server port
 *   --timeout=180            seconds to wait for the renderer to become ready
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PORT = Number(process.env.QA_PORT || 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HEADLESS = process.env.QA_HEADLESS !== '0';
const USE_GPU = process.env.QA_GPU === '1';

/** Chromium flags: deterministic software WebGL2, or the real GPU on request. */
const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];
const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
/**
 * Perf mode uncaps requestAnimationFrame; a vsynced page reports 16.7 ms no
 * matter how much work the layer adds, which would hide the measurement the
 * harness exists for. Only used by this script, never by the e2e suite.
 */
const PERF_ARGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-features=CalculateNativeWinOcclusion'];
const CHROMIUM_ARGS = [...(USE_GPU ? GPU_ARGS : SWIFTSHADER_ARGS), ...PERF_ARGS];

const VIEWPORT = { width: 1600, height: 900 };

/**
 * Fixed views. `orthoHeight` is the vertical frustum extent in metres, matching
 * `CameraSettings.orthoHeight`; the focus is in local metres (east, north).
 * The three baselines from the plan are near / middle / whole city; the extra
 * corridor views are filled in once the verified corridors are known.
 */
const ALL_VIEWS = {
  near: { focus: [0, 0], orthoHeight: 110, note: 'ближний вид, центр (Октябрьская площадь)' },
  mid: { focus: [0, 0], orthoHeight: 420, note: 'средний вид, центр' },
  overview: { focus: [0, 0], orthoHeight: 660, note: 'обзор пилота (peak orthoHeight по умолчанию)' },
  city: { focus: [0, 0], orthoHeight: 2600, note: 'городской обзор (maxOrthoHeight)' },
};

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function readArgs(argv) {
  const options = {
    dataset: 'central',
    mobility: 'off',
    views: null,
    samples: 5,
    warmup: 3,
    out: '',
    timeout: 180,
    port: PORT,
  };
  for (const arg of argv) {
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (!match) {
      if (arg === '--help' || arg === '-h') {
        console.log('see the header of scripts/qa/mobility-perf.mjs');
        process.exit(0);
      }
      throw new Error(`unknown argument: ${arg}`);
    }
    const [, key, value] = match;
    if (key === 'dataset' || key === 'mobility' || key === 'out') options[key] = value;
    else if (key === 'views') options.views = value.split(',').map((name) => name.trim()).filter(Boolean);
    else if (key === 'samples' || key === 'warmup' || key === 'timeout' || key === 'port') {
      options[key] = Number(value);
    } else throw new Error(`unknown flag: --${key}`);
  }
  if (!['central', 'city'].includes(options.dataset)) throw new Error('--dataset must be central or city');
  if (!['off', 'on'].includes(options.mobility)) throw new Error('--mobility must be off or on');
  return options;
}

// --------------------------------------------------------------------------
// dev server management (mirrors scripts/qa/capture.mjs)
// --------------------------------------------------------------------------

let serverProcess = null;
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

async function ensureServer(port) {
  const url = `http://127.0.0.1:${port}`;
  if (await probeServer(url)) {
    console.log(`[server] reusing dev server on ${url}`);
    return url;
  }
  console.log(`[server] starting: pnpm exec vite --port ${port} --strictPort --host 127.0.0.1`);
  serverProcess = spawn(
    'pnpm',
    ['exec', 'vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
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
      throw new Error(`dev server exited (${serverProcess.exitCode})\n${serverOutput.join('')}`);
    }
    if (await probeServer(url)) {
      console.log(`[server] ready at ${url}`);
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
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
  } catch (error) {
    console.warn(`[server] stop failed: ${String(error)}`);
  }
}

// --------------------------------------------------------------------------
// browser-side probes
// --------------------------------------------------------------------------

/** In-page readiness probe: city handle ready and geometry actually on screen. */
const READY_PROBE = () => {
  const api = window.__CITY_APP__;
  const stats = window.__CITY_STATS__ ?? api?.stats ?? null;
  const hasGeometry = !!stats && stats.loadedTiles > 0 && stats.triangles > 0;
  if (api && api.ready === true && hasGeometry) return 'ready';
  if (!api && hasGeometry) return 'stats-only';
  return false;
};

const GPU_PROBE = () => {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { renderer: 'none', vendor: 'none' };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'masked',
      vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : 'masked',
    };
  } catch (error) {
    return { renderer: `error: ${String(error)}`, vendor: 'error' };
  }
};

/**
 * Sample requestAnimationFrame deltas for `seconds` and summarise them in the
 * page (percentiles are more honest than an average: a single 200 ms hitch must
 * show up in p95/max, not disappear into the mean).
 */
async function sampleFrames(page, seconds) {
  return page.evaluate(async (durationSeconds) => {
    const deltas = [];
    const start = performance.now();
    let last = start;
    await new Promise((resolve) => {
      const tick = (now) => {
        deltas.push(now - last);
        last = now;
        if (now - start >= durationSeconds * 1000) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Drop the first sample: it contains the evaluate() round trip, not a frame.
    const values = deltas.slice(1).sort((a, b) => a - b);
    const pick = (q) => (values.length ? values[Math.min(values.length - 1, Math.floor(q * values.length))] : 0);
    const sum = values.reduce((total, value) => total + value, 0);
    return {
      frames: values.length,
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
      max: values.length ? values[values.length - 1] : 0,
      mean: values.length ? sum / values.length : 0,
      longFrames: values.filter((value) => value > 33.4).length,
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / (1024 * 1024) : null,
    };
  }, seconds);
}

/** Read the app's own counters (the same object tests and the HUD use). */
async function readStats(page) {
  return page.evaluate(() => window.__CITY_STATS__ ?? window.__CITY_APP__?.stats ?? null);
}

/** Poll until rendering is genuinely under way, with a hard deadline. */
async function waitForReady(page, timeoutSeconds) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const probe = await page.evaluate(READY_PROBE).catch(() => false);
    if (probe) {
      console.log(`[ready] ${probe} after ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
      return probe;
    }
    const overlay = await page
      .evaluate(() => document.querySelector('[data-testid="error-message"]')?.textContent ?? '')
      .catch(() => '');
    if (overlay.trim()) throw new Error(`renderer reported a fatal error: ${overlay.trim()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const snapshot = await page
    .evaluate(() => ({
      url: location.href,
      hasApi: typeof window.__CITY_APP__ !== 'undefined',
      ready: window.__CITY_APP__?.ready,
      stats: window.__CITY_STATS__ ?? null,
    }))
    .catch(() => null);
  throw new Error(
    `renderer did not become ready within ${timeoutSeconds} s\nsnapshot: ${JSON.stringify(snapshot)}\n` +
      serverOutput.join(''),
  );
}

/**
 * Two consecutive identical stats snapshots mean streaming has settled; the
 * measurement then reflects a warm map instead of a half-loaded one.
 */
async function waitForStableStats(page, timeoutSeconds = 120) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let previous = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    const stats = await readStats(page);
    const signature = stats ? `${stats.loadedTiles}/${stats.triangles}/${Math.round(stats.geometryMB)}` : '';
    if (signature && signature === previous) {
      if (Date.now() - stableSince > 2000) return stats;
    } else {
      previous = signature;
      stableSince = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return readStats(page);
}

async function setView(page, view) {
  await page.evaluate(
    async ({ focus, orthoHeight }) => {
      const app = window.__CITY_APP__?.app;
      if (!app) throw new Error('__CITY_APP__.app is missing');
      app.setCameraSettings({ orthoHeight });
      app.focusOnLocal(focus[0], focus[1]);
      // Let the streamer catch up with the new area.
      await new Promise((resolve) => setTimeout(resolve, 400));
    },
    { focus: view.focus, orthoHeight: view.orthoHeight },
  );
}

/**
 * Toggle the mobility layer through the public app API. The exact method names
 * are part of the integration contract (`CityAppHandle`), so a missing method is
 * a hard failure: measuring "on" while the layer is absent would fake progress.
 */
async function setMobility(page, enabled) {
  const available = await page.evaluate(() => {
    const app = window.__CITY_APP__?.app;
    if (!app) return { ok: false, reason: 'no app handle' };
    if (typeof app.setMobilitySettings !== 'function') return { ok: false, reason: 'no setMobilitySettings' };
    return { ok: true };
  });
  if (!available.ok) throw new Error(`mobility API unavailable: ${available.reason}`);
  await page.evaluate((value) => {
    window.__CITY_APP__.app.setMobilitySettings({ vehiclesVisible: value, signalsVisible: value });
  }, enabled);
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  const options = readArgs(process.argv.slice(2));
  const viewNames = options.views ?? (options.dataset === 'city' ? ['near', 'mid', 'city'] : ['near', 'mid', 'overview']);
  const views = {};
  for (const name of viewNames) {
    const view = ALL_VIEWS[name];
    if (!view) throw new Error(`unknown view "${name}" (available: ${Object.keys(ALL_VIEWS).join(', ')})`);
    views[name] = view;
  }
  const outPath = path.resolve(
    ROOT,
    options.out || `screenshots/mobility-perf-${options.dataset}-${options.mobility}.json`,
  );

  const baseUrl = await ensureServer(options.port).catch((error) => {
    stopServer();
    throw error;
  });
  const query = new URLSearchParams({ dataset: options.dataset === 'city' ? 'city' : 'central' });
  const url = `${baseUrl}/?${query.toString()}`;

  const browser = await chromium.launch({ headless: HEADLESS, args: CHROMIUM_ARGS });
  const results = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    dataset: options.dataset,
    mobility: options.mobility,
    gpuRequested: USE_GPU ? 'hardware (QA_GPU=1)' : 'swiftshader',
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    samplesSeconds: options.samples,
    warmupSeconds: options.warmup,
    url,
    gpu: null,
    userAgent: null,
    views: {},
  };

  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    console.log(`[browser] ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await waitForReady(page, options.timeout);
    results.gpu = await page.evaluate(GPU_PROBE);
    results.userAgent = await page.evaluate(() => navigator.userAgent);
    console.log(`[gpu] ${results.gpu.renderer}`);

    if (options.mobility === 'on') await setMobility(page, true);
    else await setMobility(page, false).catch((error) => console.log(`[mobility] ${String(error)}`));

    for (const [name, view] of Object.entries(views)) {
      await setView(page, view);
      const settled = await waitForStableStats(page, Math.max(60, options.timeout));
      await page.waitForTimeout(options.warmup * 1000);
      const frames = await sampleFrames(page, options.samples);
      const stats = await readStats(page);
      results.views[name] = { ...view, frames, stats, settledTiles: settled?.loadedTiles ?? null };
      console.log(
        `[view] ${name} p50=${frames.p50.toFixed(2)} ms p95=${frames.p95.toFixed(2)} ms ` +
          `max=${frames.max.toFixed(1)} ms frames=${frames.frames} ` +
          `tiles=${stats?.loadedTiles ?? '?'} tris=${stats?.triangles ?? '?'} ` +
          `calls=${stats?.drawCalls ?? '?'} geom=${stats?.geometryMB ?? '?'} MB`,
      );
    }
    results.consoleErrors = consoleErrors;
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    console.log(`[out] ${outPath}`);
    if (consoleErrors.length) {
      console.warn(`[warn] ${consoleErrors.length} page error(s); see the result file`);
    }
  } finally {
    await browser.close().catch(() => {});
    stopServer();
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
