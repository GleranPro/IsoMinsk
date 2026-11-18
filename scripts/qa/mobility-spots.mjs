#!/usr/bin/env node
/**
 * Isometric Minsk — fixed independent-place visual check for mobility (QA).
 *
 * The earlier acceptance pass verified counts and one frame per case, which hid
 * placement bugs (signal heads on the asphalt, stop lines inside junctions, buses
 * hopping between lanes). This script checks a small set of INDEPENDENT places:
 * for each spot it puts a real vehicle in the frame, screenshots it, and records
 * what the simulation says about that vehicle. One place per screenshot, so a
 * wrong pole or a lane hop is visible instead of averaged away.
 *
 * Evidence (in `screenshots/mobility/spots/`):
 *   spot-<n>-<slug>.png     one frame per spot (signals readable at ~110 m)
 *   spot-<n>-<slug>.json    clock, trips near the spot, signal aspects/heads
 *   click.png               vehicle card opened by a real mouse click
 *   summary.json            verdict per spot
 *
 * Usage:
 *   node scripts/qa/mobility-spots.mjs
 *   $env:QA_GPU='1'; node scripts/qa/mobility-spots.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'screenshots', 'mobility', 'spots');
const PORT = Number(process.env.QA_PORT || 5173);
const BASE_URL = process.env.QA_BASE_URL?.trim() || `http://127.0.0.1:${PORT}`;
const HEADLESS = process.env.QA_HEADLESS !== '0';
const USE_GPU = process.env.QA_GPU === '1';
const SERVICE_DATE = process.env.QA_DATE?.trim() || '2026-11-16';
const VIEWPORT = { width: 1600, height: 900 };

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
 * Independent places. Signal-node spots sit on real junctions from the payload
 * (the earlier list used stop midpoints that had no signal at all). Zoom 100 m
 * keeps signal heads above the layer's screen-size LOD (~112 m), so the poles
 * are actually drawn and can be checked.
 */
const SPOTS = [
  { slug: 'bus-junction-masherova', focus: [134, 1627], ortho: 100, mode: 'bus', radiusM: 50 },
  { slug: 'bus-junction-pobedy', focus: [1375, 167], ortho: 100, mode: 'bus', radiusM: 50 },
  { slug: 'bus-junction-perespa', focus: [-722, 2072], ortho: 100, mode: 'bus', radiusM: 50 },
  { slug: 'bus-stop-theatre', focus: [-237, 1731], ortho: 110, mode: 'bus', radiusM: 40 },
  { slug: 'tram-junction', focus: [3270, -4247], ortho: 100, mode: 'tram', radiusM: 50 },
  { slug: 'tram-bridge-junction', focus: [3583, -4047], ortho: 100, mode: 'tram', radiusM: 50 },
  // Mid-block tram sections: the place where signal heads used to end up in the
  // middle of the avenue (pedestrian heads of unsignalised crossings).
  { slug: 'tram-midblock-serebryanka', focus: [3426, -4177], ortho: 130, mode: 'tram', radiusM: 45 },
  { slug: 'tram-midblock-budenogo', focus: [3794, -1701], ortho: 130, mode: 'tram', radiusM: 45 },
];

// --------------------------------------------------------------------------
// dev server (same pattern as the other QA scripts)
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

async function ensureServer() {
  if (await probeServer(BASE_URL)) return;
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
    if (await probeServer(BASE_URL)) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`dev server did not become reachable\n${serverOutput.join('')}`);
}

function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  try {
    spawnSync('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

// --------------------------------------------------------------------------
// browser side
// --------------------------------------------------------------------------

async function waitForReady(page) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (
      await page
        .evaluate(() => window.__CITY_APP__?.ready === true && (window.__CITY_STATS__?.loadedTiles ?? 0) > 0)
        .catch(() => false)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('renderer did not become ready');
}

/** Find a service time with a vehicle of `mode` within `radiusM` of the spot. */
async function searchMoment(page, spot) {
  for (let seconds = 8 * 3600; seconds <= 8 * 3600 + 2400; seconds += 5) {
    const hit = await page.evaluate(
      ({ date, sec, point, mode, radius }) => {
        const app = window.__CITY_APP__?.app;
        if (!app) return null;
        app.setMobilityServiceDate(date, sec);
        const dump = app.getMobilityDump();
        const trip = (dump?.trips ?? []).find(
          (candidate) =>
            candidate.mode === mode &&
            Math.hypot(candidate.x - point[0], candidate.y - point[1]) <= radius,
        );
        if (!trip) return null;
        return {
          seconds: sec,
          trip: {
            tripId: trip.tripId,
            ref: trip.ref,
            variantId: trip.variantId,
            phase: trip.phase,
            x: trip.x,
            y: trip.y,
            h: trip.h,
            delayS: trip.delayS,
            speed: trip.speed,
          },
        };
      },
      { date: SERVICE_DATE, sec: seconds, point: spot.focus, mode: spot.mode, radius: spot.radiusM },
    );
    if (hit) return hit;
  }
  return null;
}

async function readSpotData(page, spot) {
  return page.evaluate(
    ({ point, radius }) => {
      const app = window.__CITY_APP__?.app;
      const dump = app?.getMobilityDump();
      const near = (x, y) => Math.hypot(x - point[0], y - point[1]) <= radius;
      return {
        clock: dump?.clock ?? null,
        status: app?.getMobilityStatus?.() ?? null,
        trips: (dump?.trips ?? []).filter((trip) => near(trip.x, trip.y)),
        signals: (dump?.signals ?? [])
          .filter((node) => near(node.x, node.y))
          .map((node) => ({ nodeId: node.nodeId, phase: node.phase, aspects: node.aspects })),
      };
    },
    { point: spot.focus, radius: spot.radiusM * 2.5 },
  );
}

/**
 * Project a world position to CSS pixels with the engine's own QA projection
 * (`__CITY_DEBUG__.projectLocal`), then click the vehicle and read the route
 * card. This proves the click path end-to-end, not just the API.
 */
async function clickVehicle(page, trip) {
  return page.evaluate(
    ({ trip }) => {
      const debug = window.__CITY_DEBUG__;
      if (!debug || typeof debug.projectLocal !== 'function') {
        return { ok: false, reason: 'no projectLocal in debug API' };
      }
      const projected = debug.projectLocal(trip.x, trip.y, trip.h + 1.6);
      return {
        ok: projected.visible === true,
        px: projected.x,
        py: projected.y,
        reason: projected.visible === true ? undefined : 'vehicle projects outside the canvas',
      };
    },
    { trip },
  );
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await ensureServer();
  const browser = await chromium.launch({ headless: HEADLESS, args: CHROMIUM_ARGS });
  const summary = [];
  const consoleMessages = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('console', (message) => consoleMessages.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => consoleMessages.push(`[pageerror] ${String(error)}`));
    await page.goto(`${BASE_URL}/?dataset=city`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await waitForReady(page);
    await page.evaluate(() => {
      const app = window.__CITY_APP__?.app;
      app?.setMobilitySettings({ vehiclesVisible: true, signalsVisible: true, paused: false });
    });

    let clickVerified = false;
    for (const [index, spot] of SPOTS.entries()) {
      const moment = await searchMoment(page, spot);
      if (!moment) {
        summary.push({ ...spot, ok: false, reason: 'no vehicle reached the spot in the QA window' });
        console.error(`[spot ${index + 1}] ${spot.slug}: no vehicle found`);
        continue;
      }
      await page.evaluate(
        ({ point, zoom }) => {
          const app = window.__CITY_APP__?.app;
          app?.setCameraSettings({ orthoHeight: zoom, azimuth: Math.PI / 4 });
          app?.focusOnLocal(point[0], point[1]);
        },
        { point: spot.focus, zoom: spot.ortho },
      );
      await page.waitForTimeout(700);
      const name = `spot-${index + 1}-${spot.slug}`;
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
      const data = await readSpotData(page, spot);
      await writeFile(
        path.join(OUT_DIR, `${name}.json`),
        `${JSON.stringify({ spot, moment, data }, null, 2)}\n`,
        'utf8',
      );
      console.log(
        `[spot ${index + 1}] ${spot.slug}: ${moment.trip.ref} ${moment.trip.tripId} at ${moment.seconds}s ` +
          `(${moment.trip.phase}), trips in view ${data.trips.length}, signals in view ${data.signals.length}`,
      );
      summary.push({ ...spot, ok: true, trip: moment.trip, seconds: moment.seconds });

      // Click test once, on the first spot that has the vehicle on screen.
      if (!clickVerified) {
        const target = await clickVehicle(page, moment.trip);
        if (target.ok && Number.isFinite(target.px) && Number.isFinite(target.py)) {
          await page.mouse.click(target.px, target.py);
          await page.waitForTimeout(600);
          const ref = await page
            .locator('[data-testid="mobility-panel-ref"]')
            .textContent({ timeout: 5000 })
            .catch(() => null);
          const nextStop = await page
            .locator('[data-testid="mobility-panel-next-stop"]')
            .textContent()
            .catch(() => null);
          await page.screenshot({ path: path.join(OUT_DIR, 'click.png') });
          console.log(`[click] panel ref="${ref}" next stop="${nextStop}"`);
          if (ref && ref.trim() === moment.trip.ref) {
            clickVerified = true;
            summary.push({ clickTest: true, ref: ref.trim(), nextStop });
          } else {
            summary.push({ clickTest: false, expected: moment.trip.ref, got: ref });
          }
          // Close the card again so the following spot frames are not covered by it.
          await page
            .getByTestId('mobility-panel')
            .locator('button.close')
            .click({ timeout: 3000 })
            .catch(() => undefined);
          await page.waitForTimeout(200);
        } else {
          summary.push({ clickTest: false, reason: target.reason ?? 'vehicle outside the canvas' });
        }
      }
    }

    await writeFile(
      path.join(OUT_DIR, 'summary.json'),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), serviceDate: SERVICE_DATE, clickVerified, summary }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(path.join(OUT_DIR, 'console.log'), `${consoleMessages.join('\n')}\n`, 'utf8');
    const failures = summary.filter((entry) => entry.ok === false);
    if (failures.length > 0) {
      console.error(`[fatal] ${failures.length} spot(s) failed:`);
      for (const failure of failures) console.error(`  - ${failure.slug}: ${failure.reason}`);
      process.exitCode = 2;
    } else {
      console.log(`[ok] spots captured${clickVerified ? ', click verified' : ', CLICK NOT VERIFIED'}`);
      if (!clickVerified) process.exitCode = 2;
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
