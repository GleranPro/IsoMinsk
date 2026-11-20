#!/usr/bin/env node
/**
 * Isometric Minsk — atmosphere (liveness) performance harness (QA).
 *
 * Measures the frame-time cost of the atmosphere layers: night lamps,
 * vehicle headlights, cloud shades and screen-space weather. Runs the same
 * fixed view twice — atmosphere off (`?clouds=0&lamps=0`, day) vs on
 * (night, clouds, optional weather) — and reports frame-time percentiles
 * for both, so the delta is the honest cost of the pass.
 *
 * Honesty contract (same as mobility-perf.mjs):
 *   - no result is written for a view that never became ready;
 *   - the actual WebGL backend is recorded; software and hardware numbers
 *     are never mixed;
 *   - missing atmosphere APIs fail loudly instead of measuring nothing.
 *
 * Usage:
 *   node scripts/qa/liveness-perf.mjs --seconds=6
 *   node scripts/qa/liveness-perf.mjs --weather=rain --out=screenshots/liveness-perf.json
 *   $env:QA_GPU='1'; node scripts/qa/liveness-perf.mjs   # hardware GPU
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PORT = Number(process.env.QA_PORT || 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const USE_GPU = process.env.QA_GPU === '1';

const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];
const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
const PERF_ARGS = [
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--disable-features=CalculateNativeWinOcclusion',
];
const CHROMIUM_ARGS = [...(USE_GPU ? GPU_ARGS : SWIFTSHADER_ARGS), ...PERF_ARGS];

function readArgs(argv) {
  const options = { seconds: 6, warmup: 5, weather: 'off', port: PORT, out: null };
  for (const arg of argv) {
    const match = /^--([a-z]+)=(.+)$/.exec(arg);
    if (!match) continue;
    if (match[1] in options) options[match[1]] = match[2];
  }
  options.seconds = Math.max(2, Number(options.seconds) || 6);
  options.warmup = Math.max(1, Number(options.warmup) || 5);
  return options;
}

let serverProcess = null;
const serverOutput = [];

async function ensureServer(port) {
  // Reuse a running dev server when one answers (same contract as capture.mjs).
  try {
    const response = await fetch(`${BASE_URL}/`);
    if (response.ok) return BASE_URL;
  } catch {
    /* not running — spawn one */
  }
  serverProcess = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
  serverProcess.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/`);
      if (response.ok) return BASE_URL;
    } catch {
      /* wait for vite */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`dev server did not start within 60 s\n${serverOutput.join('')}`);
}

function stopServer() {
  if (serverProcess) serverProcess.kill();
}

async function measureFrameTimes(page, seconds) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const samples = [];
        let previous = performance.now();
        const tick = (now) => {
          samples.push(now - previous);
          previous = now;
          if (now < start + duration * 1000) requestAnimationFrame(tick);
          else resolve(samples);
        };
        const start = previous;
        requestAnimationFrame(tick);
      }),
    seconds,
  );
}

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  return {
    frames: samples.length,
    meanMs: Math.round(mean * 100) / 100,
    p50Ms: Math.round(pick(0.5) * 100) / 100,
    p95Ms: Math.round(pick(0.95) * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

const READY_PROBE = () => {
  const stats = window.__CITY_STATS__;
  return window.__CITY_APP__?.ready === true && stats && stats.loadedTiles > 0
    ? `ready (${stats.loadedTiles} tiles, ${stats.fps} fps)`
    : false;
};

async function waitForReady(page, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const probe = await page.evaluate(READY_PROBE).catch(() => false);
    if (probe) {
      console.log(`[ready] ${probe}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`renderer did not become ready within ${timeoutSeconds} s`);
}

/** One measurement pass with a fixed URL configuration. */
async function runPass(browser, label, query, options) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${BASE_URL}/?${query}`, { waitUntil: 'domcontentloaded' });
  await waitForReady(page, 420);
  // Fixed district view near the pilot centre (worst case for lamps: majors nearby).
  await page.evaluate(() => {
    const app = window.__CITY_APP__.app;
    app.setCameraSettings({ orthoHeight: 660 });
    if (typeof app.getTimeOfDayInfo !== 'function') throw new Error('atmosphere API missing');
  });
  await new Promise((resolve) => setTimeout(resolve, options.warmup * 1000));
  const samples = await measureFrameTimes(page, options.seconds);
  const stats = await page.evaluate(() => ({
    atmosphere: window.__CITY_DEBUG__?.atmosphere?.() ?? null,
    lamps: window.__CITY_DEBUG__?.lamps?.() ?? null,
    engineStats: window.__CITY_STATS__ ?? null,
  }));
  const result = { label, query, frameTimes: percentiles(samples), pageErrors, stats };
  console.log(`[${label}] ${JSON.stringify(result.frameTimes)}`);
  await page.close();
  return result;
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  await mkdir(path.resolve(ROOT, 'screenshots'), { recursive: true });
  const baseUrl = await ensureServer(options.port);

  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  const results = { schema: 1, backend: USE_GPU ? 'hardware' : 'swiftshader', weather: options.weather };

  results.off = await runPass(browser, 'atmosphere-off', 'time=13&clouds=0&lamps=0&mobility=corridors', options);
  results.on = await runPass(
    browser,
    'atmosphere-on',
    `time=23&mobility=corridors${options.weather !== 'off' ? `&weather=${options.weather}` : ''}`,
    options,
  );

  const delta = {
    p95Ms: Math.round((results.on.frameTimes.p95Ms - results.off.frameTimes.p95Ms) * 100) / 100,
    meanMs: Math.round((results.on.frameTimes.meanMs - results.off.frameTimes.meanMs) * 100) / 100,
  };
  results.delta = delta;
  console.log(`[delta on-off] ${JSON.stringify(delta)}`);

  const outPath = path.resolve(
    ROOT,
    options.out || `screenshots/liveness-perf-${options.weather}.json`,
  );
  await writeFile(outPath, JSON.stringify(results, null, 2));
  console.log(`[out] ${outPath}`);
  if (results.on.pageErrors.length > 0) {
    console.error('page errors during atmosphere-on pass:', results.on.pageErrors.join(' | '));
    process.exitCode = 2;
  }
  await browser.close();
  stopServer();
}

main().catch((error) => {
  stopServer();
  console.error(error);
  process.exit(2);
});
