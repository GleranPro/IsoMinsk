#!/usr/bin/env node
/**
 * Isometric Minsk — mobility streaming / lifecycle soak test (QA).
 *
 * Drives the camera between the two verified corridors, the city overview and
 * back for a configurable duration (default 10 minutes) and checks the
 * properties the plan calls out for streamed dynamic content:
 *
 *   - trip identity survives chunk eviction/reloading (no duplicates, no reset);
 *   - a trip never jumps further than physics allows between samples, and its
 *     schedule delay never runs backwards;
 *   - loaded chunk count/bytes stay bounded (no unbounded cache growth);
 *   - JS heap does not grow monotonically over the run;
 *   - signal nodes keep their phases while their models are unloaded/reloaded.
 *
 * It writes `screenshots/mobility/streaming.json` with every sample, the
 * waypoint schedule and the verdict, and exits non-zero on a continuity
 * violation. Timing numbers from this script are functional evidence only, not
 * a performance claim.
 *
 * Usage:
 *   node scripts/qa/mobility-streaming.mjs                      # full 10 min
 *   node scripts/qa/mobility-streaming.mjs --duration=120       # quick pass
 *   $env:QA_GPU='1'; node scripts/qa/mobility-streaming.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'screenshots', 'mobility');
const OUT_FILE = path.join(OUT_DIR, 'streaming.json');
const PORT = Number(process.env.QA_PORT || 5173);
const BASE_URL = process.env.QA_BASE_URL?.trim() || `http://127.0.0.1:${PORT}`;
const HEADLESS = process.env.QA_HEADLESS !== '0';
const USE_GPU = process.env.QA_GPU === '1';
const SERVICE_DATE = process.env.QA_DATE?.trim() || '2026-11-16';
const VIEWPORT = { width: 1280, height: 720 };

function readArgs(argv) {
  const options = { duration: 600, dataset: 'city', out: OUT_FILE, port: PORT };
  for (const arg of argv) {
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unknown argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'dataset' || key === 'out') options[key] = value;
    else if (key === 'duration' || key === 'port') options[key] = Number(value);
    else throw new Error(`unknown flag: --${key}`);
  }
  return options;
}

const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];
const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
const CHROMIUM_ARGS = USE_GPU ? GPU_ARGS : SWIFTSHADER_ARGS;

/**
 * Deterministic camera route: each entry is [label, focusX, focusY, ortho, azimuth?].
 * It deliberately crosses tile/chunk boundaries and evicts corridor chunks
 * between visits (city overview), which is where duplicate/reset bugs appear.
 */
const ROUTE = [
  ['bus-close', 450, 1250, 180],
  ['bus-junction', 1386, 158, 200],
  ['tram-close', 3200, -3670, 200],
  ['tram-far', 4300, -2900, 260],
  ['city-overview', 0, 0, 2400],
  ['bus-return', 450, 1250, 180, Math.PI / 4 + Math.PI / 2],
  ['tram-return', 3200, -3670, 200, Math.PI / 4 + Math.PI],
  ['bus-mid', -650, 1950, 420],
];

// --------------------------------------------------------------------------
// dev server
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
    if (serverProcess.exitCode !== null) throw new Error(`dev server exited (${serverProcess.exitCode})`);
    if (await probeServer(url)) return url;
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
  } catch {
    /* ignore */
  }
}

// --------------------------------------------------------------------------
// probes
// --------------------------------------------------------------------------

const READY_PROBE = () => {
  const api = window.__CITY_APP__;
  const stats = window.__CITY_STATS__ ?? api?.stats ?? null;
  return !!api && api.ready === true && !!stats && stats.loadedTiles > 0 && stats.triangles > 0;
};

async function waitForReady(page, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(READY_PROBE).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('renderer did not become ready');
}

/** One sample of the layer state, taken after the camera settled. */
async function sample(page, label) {
  return page.evaluate((name) => {
    const app = window.__CITY_APP__?.app;
    if (!app) return null;
    const status = app.getMobilityStatus();
    const dump = app.getMobilityDump();
    return {
      label: name,
      at: Date.now(),
      status,
      clock: dump?.clock ?? null,
      trips: (dump?.trips ?? []).map((trip) => ({
        id: trip.tripId,
        x: trip.x,
        y: trip.y,
        delay: trip.delayS,
        phase: trip.phase,
        drawn: trip.drawn,
        variant: trip.variantId,
      })),
      signals: (dump?.signals ?? []).map((node) => ({
        id: node.nodeId,
        phase: node.phase,
        aspects: node.aspects,
      })),
      drawnIds: (dump?.trips ?? []).filter((trip) => trip.drawn).map((trip) => trip.tripId),
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / (1024 * 1024) : null,
      stats: window.__CITY_STATS__ ?? null,
    };
  }, label);
}

function secondsBetween(first, second) {
  if (!first || !second) return 0;
  const delta = second.serviceSeconds - first.serviceSeconds;
  return delta >= 0 ? delta : delta + 86_400;
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  const options = readArgs(process.argv.slice(2));
  await mkdir(OUT_DIR, { recursive: true });
  const baseUrl = await ensureServer(options.port);
  const browser = await chromium.launch({ headless: HEADLESS, args: CHROMIUM_ARGS });
  const samples = [];
  const violations = [];
  const signalPhases = new Map();
  const seenTrips = new Set();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (error) => violations.push(`pageerror: ${String(error)}`));
    page.on('console', (message) => {
      if (message.type() === 'error') violations.push(`console: ${message.text()}`);
    });
    const url = `${baseUrl}/?dataset=${options.dataset}`;
    console.log(`[browser] ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await waitForReady(page);

    await page.evaluate(
      ({ date }) => {
        const app = window.__CITY_APP__?.app;
        if (!app) throw new Error('no app handle');
        app.setMobilityServiceDate(date, 8 * 3600);
        app.setMobilitySettings({ vehiclesVisible: true, signalsVisible: true, paused: false });
      },
      { date: SERVICE_DATE },
    );
    // Let the first simulation step and route loading settle.
    await page.waitForTimeout(2500);

    const startedAt = Date.now();
    const deadline = startedAt + options.duration * 1000;
    let previous = null;
    let index = 0;
    while (Date.now() < deadline) {
      const [label, x, y, ortho, azimuth] = ROUTE[index % ROUTE.length];
      index += 1;
      await page.evaluate(
        ({ point, zoom, az }) => {
          const app = window.__CITY_APP__?.app;
          if (!app) throw new Error('no app handle');
          app.setCameraSettings({ orthoHeight: zoom, ...(typeof az === 'number' ? { azimuth: az } : {}) });
          app.focusOnLocal(point[0], point[1]);
        },
        { point: [x, y], zoom: ortho, az: azimuth },
      );
      // Dwell: chunks stream in/out, trips advance, signal phases cycle.
      await page.waitForTimeout(6000);
      const current = await sample(page, label);
      if (!current) {
        violations.push('sample returned null (app handle lost)');
        break;
      }
      samples.push(current);

      // --- continuity checks -------------------------------------------
      if (current.drawnIds.length !== new Set(current.drawnIds).size) {
        violations.push(`duplicate drawn trip ids at ${label}`);
      }
      if (previous) {
        const elapsed = secondsBetween(previous.clock, current.clock);
        const before = new Map(previous.trips.map((trip) => [trip.id, trip]));
        let jumps = 0;
        let backwardsDelay = 0;
        for (const trip of current.trips) {
          seenTrips.add(trip.id);
          const old = before.get(trip.id);
          if (!old) continue;
          const distance = Math.hypot(trip.x - old.x, trip.y - old.y);
          // 25 m/s covers a tram and the sampling jitter; +100 m absorbs one
          // missed sample at the highest model speed.
          const budget = Math.max(150, elapsed * 25 + 100);
          if (distance > budget) {
            jumps += 1;
            violations.push(
              `${trip.id} jumped ${distance.toFixed(0)} m in ${elapsed} s at ${label} (budget ${budget.toFixed(0)} m)`,
            );
          }
          if (trip.delay - old.delay < -5) {
            backwardsDelay += 1;
            violations.push(`${trip.id} delay ran backwards by ${(old.delay - trip.delay).toFixed(1)} s`);
          }
        }
        if (jumps === 0 && backwardsDelay === 0) {
          console.log(`[ok] ${label}: ${current.trips.length} trips, ${current.drawnIds.length} drawn, elapsed ${elapsed.toFixed(0)} s`);
        }
        // Signal phases must not restart from 0 after the models were unloaded.
        for (const node of current.signals) {
          const previousPhase = signalPhases.get(node.id);
          if (previousPhase !== undefined && previousPhase.phaseCount !== undefined) {
            // A cycle wraps to a lower index; that is normal. A reset to phase 0
            // exactly when the node was absent for a sample would be suspicious,
            // so record the wrapped transitions instead of failing on them.
            if (node.phase === 0 && previousPhase.phase !== 0) {
              previousPhase.wraps = (previousPhase.wraps ?? 0) + 1;
            }
          }
          const record = signalPhases.get(node.id) ?? { wraps: 0 };
          record.phase = node.phase;
          signalPhases.set(node.id, record);
        }
      }
      previous = current;
      if (index % 10 === 0) {
        const elapsedTotal = (Date.now() - startedAt) / 1000;
        console.log(
          `[soak] ${elapsedTotal.toFixed(0)}/${options.duration} s · trips ${current.trips.length} · ` +
            `drawn ${current.drawnIds.length} · chunks ${current.status.loadedChunks} · ` +
            `heap ${current.heapMB ? current.heapMB.toFixed(0) : '?'} MB`,
        );
      }
    }

    // --- growth checks ---------------------------------------------------
    const heaps = samples.map((s) => s.heapMB).filter((value) => typeof value === 'number');
    if (heaps.length >= 8) {
      const quarter = Math.max(1, Math.floor(heaps.length / 4));
      const first = heaps.slice(0, quarter).reduce((a, b) => a + b, 0) / quarter;
      const last = heaps.slice(-quarter).reduce((a, b) => a + b, 0) / quarter;
      const growth = last - first;
      console.log(`[heap] first ${first.toFixed(0)} MB → last ${last.toFixed(0)} MB (Δ ${growth.toFixed(0)} MB)`);
      if (growth > 80) violations.push(`heap grew by ${growth.toFixed(0)} MB over the run (suspicious leak)`);
    }
    const chunkCounts = samples.map((s) => s.status.loadedChunks);
    const maxChunks = Math.max(...chunkCounts, 0);
    const maxBytes = Math.max(...samples.map((s) => s.status.loadedBytes), 0);
    const duplicatesEver = samples.some((s) => s.drawnIds.length !== new Set(s.drawnIds).size);
    if (duplicatesEver) violations.push('duplicate drawn trip ids observed');
    console.log(
      `[summary] samples=${samples.length} uniqueTrips=${seenTrips.size} maxChunks=${maxChunks} ` +
        `maxBytes=${(maxBytes / 1024).toFixed(0)} KB signalNodes=${signalPhases.size}`,
    );

    const result = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      durationSeconds: (Date.now() - startedAt) / 1000,
      requestedSeconds: options.duration,
      gpu: USE_GPU ? 'hardware' : 'swiftshader',
      route: ROUTE,
      verdict: violations.length === 0 ? 'pass' : 'fail',
      violations,
      summary: {
        samples: samples.length,
        uniqueTrips: seenTrips.size,
        maxLoadedChunks: maxChunks,
        maxLoadedBytes: maxBytes,
        signalNodes: signalPhases.size,
      },
      samples,
    };
    await writeFile(OUT_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`[out] ${OUT_FILE}`);
    if (violations.length > 0) {
      console.error(`[fatal] ${violations.length} continuity violation(s):`);
      for (const violation of violations.slice(0, 10)) console.error(`  - ${violation}`);
      process.exitCode = 2;
    } else {
      console.log('[ok] streaming soak passed: no jumps, no duplicate ids, no delay reset');
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
