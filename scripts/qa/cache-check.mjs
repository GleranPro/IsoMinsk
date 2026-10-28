#!/usr/bin/env node
/**
 * QA: cache regression check for tile payloads.
 *
 * Tile URLs are stable (`/data/city-tiles/<x>_<y>.json`) while their content
 * changes whenever the dataset is regenerated. This script proves that a page
 * reload revalidates/re-fetches a changed tile instead of reusing a stale HTTP
 * cache entry (regression: `cache: 'force-cache'` in tileWorker/tileStreamer made
 * the map keep old geometry after a data update even on refresh).
 *
 * Procedure (one persistent browser profile = warm disk cache):
 *   1. load `?dataset=city`, wait for all tiles, record stats.triangles;
 *   2. temporarily empty the `buildings` array of the gate tile
 *      `public/data/city-tiles/-1_-2.json` (same URL, different bytes);
 *   3. reload, wait for all tiles, record stats.triangles;
 *   4. restore the tile file (even on failure).
 * PASS when the reloaded triangle count drops (the changed payload was fetched).
 *
 * Usage: node scripts/qa/cache-check.mjs   (needs a running dev server on 5173
 * or QA_BASE_URL, and the city dataset generated via `pnpm run data:city`).
 */
import { chromium } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BASE_URL = process.env.QA_BASE_URL?.trim() || 'http://127.0.0.1:5173';
const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
const TILE = path.join(ROOT, 'public', 'data', 'city-tiles', '-1_-2.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadAndReadStats(page, label) {
  await page.goto(`${BASE_URL}/?dataset=city`, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 120_000;
  let stats = null;
  while (Date.now() < deadline) {
    stats = await page.evaluate(() => window.__CITY_APP__?.stats ?? null);
    if (stats && stats.loadedTiles >= 144 && stats.triangles > 0) break;
    await sleep(400);
  }
  console.log(
    `[${label}] loadedTiles=${stats?.loadedTiles} triangles=${stats?.triangles} buildings=${stats?.buildings}`,
  );
  return stats;
}

const profile = await mkdtemp(path.join(os.tmpdir(), 'dsh-cache-check-'));
const original = await readFile(TILE, 'utf8');
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  args: GPU_ARGS,
  viewport: { width: 1280, height: 720 },
});
try {
  const page = await context.newPage();
  const warm = await loadAndReadStats(page, 'warm');

  const tile = JSON.parse(original);
  const removed = tile.buildings.length;
  tile.buildings = [];
  await writeFile(TILE, JSON.stringify(tile), 'utf8');
  console.log(`[mutate] removed ${removed} buildings from ${path.basename(TILE)} (bytes changed)`);

  const cold = await loadAndReadStats(page, 'reload-after-data-change');
  const delta = (warm?.triangles ?? 0) - (cold?.triangles ?? 0);
  console.log(`[result] triangle delta = ${delta}`);
  if (delta > 100) {
    console.log('PASS: tile payload was revalidated/re-fetched after the data change (no stale geometry)');
  } else {
    console.error('FAIL: reload reused the stale cached tile payload');
    process.exitCode = 1;
  }
} finally {
  await writeFile(TILE, original, 'utf8');
  await context.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
