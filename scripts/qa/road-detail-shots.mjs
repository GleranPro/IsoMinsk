#!/usr/bin/env node
/**
 * Isometric Minsk — road-detail screenshot sweep (QA).
 *
 * Captures close-ups of the street network introduced by the v0.2 centreline
 * round: lane markings, double solid centre, zebra crossings, stop lines,
 * signal heads, medians, parking stalls and bridge parapets/piers. Uses the
 * QA-only URL parameters supported by `src/engine/createCityApp.ts`
 * (`?fx=&fy=&zoom=&time=&pixel=`) so every shot is reproducible:
 *
 *   fx, fy   local-metre focus point (0,0 = pilot centre / October Square)
 *   zoom     orthographic half-height in metres (smaller = closer)
 *   pixel    1 = pixel-art postprocessing (default), 0 = clean 3D
 *   time     hour of day for the lighting preset
 *
 * Usage (PowerShell, from repo root; dev server on 5173 may already run):
 *   node scripts/qa/road-detail-shots.mjs
 *   $env:QA_GPU='1'; node scripts/qa/road-detail-shots.mjs   # hardware GPU
 *   $env:QA_BASE_URL='http://127.0.0.1:5173'; node scripts/qa/road-detail-shots.mjs
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SHOTS_DIR = path.join(ROOT, 'screenshots', 'roads');
const PORT = Number(process.env.QA_PORT || 5173);
const BASE_URL = process.env.QA_BASE_URL?.trim() || `http://127.0.0.1:${PORT}`;
const USE_GPU = process.env.QA_GPU === '1';
const VIEWPORT = { width: 1600, height: 900 };
const READY_TIMEOUT_MS = 60_000;

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
 * Shot list. Coordinates are local metres derived from the committed pilot
 * payload (crossing-dense junctions, the widest median avenues, the largest
 * parking lots and the Svislach bridges).
 */
const SHOTS = [
  {
    file: '01-junction-zebras-pixel.png',
    note: 'crossing-dense junction on the avenue: zebra bars, stop lines, signal heads',
    fx: -340,
    fy: -365,
    zoom: 80,
    pixel: 1,
    time: 13,
  },
  {
    file: '02-junction-zebras-clean.png',
    note: 'same junction without the pixel-art post pass (geometry review)',
    fx: -340,
    fy: -365,
    zoom: 80,
    pixel: 0,
    time: 13,
  },
  {
    file: '03-junction-close-pixel.png',
    note: 'very close: lane dividers and double solid centre on the carriageway',
    fx: -340,
    fy: -365,
    zoom: 42,
    pixel: 1,
    time: 13,
  },
  {
    file: '04-avenue-median-pixel.png',
    note: 'wide avenue with derived median and lane markings',
    fx: -100,
    fy: -217,
    zoom: 105,
    pixel: 1,
    time: 13,
  },
  {
    file: '05-avenue-median-clean.png',
    note: 'same avenue, clean 3D',
    fx: -100,
    fy: -217,
    zoom: 105,
    pixel: 0,
    time: 13,
  },
  {
    file: '06-parking-lot-pixel.png',
    note: 'largest off-street parking lot with stall markings',
    fx: -706,
    fy: -556,
    zoom: 55,
    pixel: 1,
    time: 13,
  },
  {
    file: '07-parking-lot-clean.png',
    note: 'same parking lot, clean 3D',
    fx: -706,
    fy: -556,
    zoom: 55,
    pixel: 0,
    time: 13,
  },
  {
    file: '08-bridge-parapets-pixel.png',
    note: 'Svislach bridge: raised deck, parapets, posts and piers',
    fx: -493,
    fy: 337,
    zoom: 65,
    pixel: 1,
    time: 13,
  },
  {
    file: '09-bridge-parapets-clean.png',
    note: 'same bridge, clean 3D',
    fx: -493,
    fy: 337,
    zoom: 65,
    pixel: 0,
    time: 13,
  },
  {
    file: '10-second-junction-pixel.png',
    note: 'second crossing-dense junction (north-east of the centre)',
    fx: 354,
    fy: 232,
    zoom: 90,
    pixel: 1,
    time: 13,
  },
  {
    file: '11-night-junction.png',
    note: 'the main junction at night (lighting sanity, markings still readable)',
    fx: -340,
    fy: -365,
    zoom: 80,
    pixel: 1,
    time: 22,
  },
  {
    file: '12-district-overview.png',
    note: 'district overview for context/markings density',
    zoom: 420,
    pixel: 1,
    time: 13,
  },
  {
    file: '13-parking-close-clean.png',
    note: 'close-up of a parking apron: stall ticks and asphalt tint',
    fx: -706,
    fy: -556,
    zoom: 28,
    pixel: 0,
    time: 13,
  },
  {
    file: '14-bridge-close-clean.png',
    note: 'close-up of a raised bridge deck: parapets, posts, piers, skirt',
    fx: -493,
    fy: 337,
    zoom: 30,
    pixel: 0,
    time: 13,
  },
  {
    file: '15-median-close-pixel.png',
    note: 'close-up of a wide avenue: derived median plus lane markings',
    fx: -100,
    fy: -217,
    zoom: 40,
    pixel: 1,
    time: 13,
  },
  {
    file: '16-bridge-very-close-clean.png',
    note: 'very close bridge deck edge: parapet posts, rail bands and piers',
    fx: -493,
    fy: 337,
    zoom: 14,
    pixel: 0,
    time: 13,
  },
  {
    file: '17-second-bridge-clean.png',
    note: 'second bridge (different deck pairing): parapet continuity check',
    fx: 197,
    fy: 433,
    zoom: 60,
    pixel: 0,
    time: 13,
  },
];

function shotUrl(shot) {
  const params = new URLSearchParams();
  if (Number.isFinite(shot.fx) && Number.isFinite(shot.fy)) {
    params.set('fx', String(shot.fx));
    params.set('fy', String(shot.fy));
  }
  if (Number.isFinite(shot.zoom)) params.set('zoom', String(shot.zoom));
  if (Number.isFinite(shot.time)) params.set('time', String(shot.time));
  if (Number.isFinite(shot.pixel)) params.set('pixel', String(shot.pixel));
  params.set('res', '900');
  return `${BASE_URL}/?${params.toString()}`;
}

async function probeServer() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(BASE_URL, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await probeServer()) {
    console.log(`[server] reusing ${BASE_URL}`);
    return null;
  }
  console.log('[server] starting vite dev server…');
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' },
  );
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (await probeServer()) return child;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('dev server did not start in 40 s');
}

async function waitForReady(page) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => window.__CITY_APP__?.ready === true)
      .catch(() => false);
    if (ready) return;
    await page.waitForTimeout(250);
  }
  throw new Error('renderer did not become ready');
}

async function waitForStats(page) {
  const deadline = Date.now() + 40_000;
  let last = null;
  while (Date.now() < deadline) {
    const stats = await page
      .evaluate(() => {
        const api = window.__CITY_APP__;
        try {
          return api?.app?.getStats?.() ?? api?.stats ?? null;
        } catch {
          return null;
        }
      })
      .catch(() => null);
    if (stats) {
      if (
        last &&
        stats.loadedTiles >= 4 &&
        stats.triangles > 5_000 &&
        stats.triangles === last.triangles &&
        stats.loadedTiles === last.loadedTiles
      ) {
        return stats;
      }
      last = stats;
    }
    await page.waitForTimeout(400);
  }
  return last;
}

async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  const server = await ensureServer();
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const meta = [];
  const only = process.env.QA_ONLY?.trim();
  const shots = only ? SHOTS.filter((shot) => shot.file.includes(only)) : SHOTS;
  if (shots.length === 0) throw new Error(`QA_ONLY="${only}" matched no shot`);
  try {
    for (const shot of shots) {
      const url = shotUrl(shot);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await waitForReady(page);
      // The React shell re-applies its own time-of-day / pixel-art state on
      // mount, so the URL flags alone are not authoritative: drive the engine
      // through the public CityAppHandle after it is ready.
      const applied = await page
        .evaluate(
          ({ pixel, time }) => {
            const app = window.__CITY_APP__?.app;
            if (!app) return null;
            if (typeof pixel === 'number') app.setPixelEffectEnabled(pixel === 1);
            if (typeof time === 'number') app.setTimeOfDay(time);
            return { pixel: app.isPixelEffectEnabled?.() ?? null, time: app.getTimeOfDay?.() ?? null };
          },
          { pixel: shot.pixel, time: shot.time },
        )
        .catch(() => null);
      const stats = await waitForStats(page);
      await page.waitForTimeout(250);
      const file = path.join(SHOTS_DIR, shot.file);
      await page.screenshot({ path: file });
      meta.push({ ...shot, url, applied, stats: stats ?? null });
      console.log(
        `[shot] ${shot.file}  zoom=${shot.zoom} pixel=${applied?.pixel ?? '?'} time=${applied?.time ?? '?'} ` +
          `tiles=${stats?.loadedTiles ?? '?'} tris=${stats?.triangles ?? '?'} draws=${stats?.drawCalls ?? '?'}`,
      );
    }
    const metaFile = only ? `shots-${only.replace(/[^a-z0-9_-]+/gi, '_')}.json` : 'shots.json';
    await writeFile(
      path.join(SHOTS_DIR, metaFile),
      JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: BASE_URL, meta, consoleErrors, pageErrors }, null, 2),
      'utf8',
    );
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      console.log(`[warn] console errors: ${consoleErrors.length}, page errors: ${pageErrors.length}`);
      process.exitCode = 1;
    } else {
      console.log('[ok] no console/page errors');
    }
  } finally {
    await browser.close().catch(() => {});
    if (server) server.kill();
  }
  console.log(`\nSaved ${SHOTS.length} road-detail screenshots to ${SHOTS_DIR}`);
}

main().catch((error) => {
  console.error('[road-detail-shots] FAILED:', error);
  process.exit(1);
});
