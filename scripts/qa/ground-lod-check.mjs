#!/usr/bin/env node
/**
 * Isometric Minsk — ground texture LOD / GPU budget check.
 *
 * Opens the app (dev server on 127.0.0.1:5173) in headless Chromium, waits for
 * every manifest tile, then reads `__CITY_DEBUG__.scene().groundTiers` (resident
 * ground textures per texel size) and the renderer texture count:
 *
 *   1. at the start view (overview),
 *   2. zoomed in on a point (QA_LOD_FOCUS="x,y,orthoHeight", default Nemiga),
 *   3. zoomed back out.
 *
 * Prints the estimated ground texture memory (RGBA + mips) for each step.
 *
 * Usage:
 *   node scripts/qa/ground-lod-check.mjs              # pilot
 *   QA_DATASET=city node scripts/qa/ground-lod-check.mjs
 */

import { chromium } from '@playwright/test';

const BASE_URL = process.env.QA_BASE_URL?.trim() || 'http://127.0.0.1:5173';
const DATASET = process.env.QA_DATASET === 'city' ? 'city' : 'pilot';
const [FX, FY, ZOOM] = (process.env.QA_LOD_FOCUS || '-350,505,40').split(',').map(Number);

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${BASE_URL}/${DATASET === 'city' ? '?dataset=city' : ''}`, { waitUntil: 'domcontentloaded' });

const manifestUrl = DATASET === 'city' ? '/data/city-tiles/manifest.json' : '/data/tiles/manifest.json';
const expected = await page.evaluate(async (url) => (await (await fetch(url)).json()).tiles.length, manifestUrl);
await page.waitForFunction(
  (n) => window.__CITY_DEBUG__ && (window.__CITY_STATS__?.loadedTiles ?? 0) >= n,
  expected,
  { timeout: 240_000, polling: 500 },
);

/** Wait until no ground re-raster is pending for a while, then sample. */
async function sample(label) {
  let last = '';
  let stableFor = 0;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(500);
    const tiers = await page.evaluate(() => JSON.stringify(window.__CITY_DEBUG__.scene().groundTiers));
    if (tiers === last) {
      stableFor += 500;
      if (stableFor >= 3000) break;
    } else {
      last = tiers;
      stableFor = 0;
    }
  }
  const info = await page.evaluate(() => ({
    tiers: window.__CITY_DEBUG__.scene().groundTiers,
    textures: window.__CITY_DEBUG__.rendererInfo().textures,
    camera: window.__CITY_APP__.app.getCameraSettings(),
    tileSize: window.__CITY_DEBUG__.scene().tiles?.length,
  }));
  const tileSize = DATASET === 'city' ? 1024 : 512;
  let bytes = 0;
  for (const [res, count] of Object.entries(info.tiers)) {
    const side = Math.round(tileSize / Number(res));
    bytes += count * side * side * 4 * (4 / 3);
  }
  console.log(
    `[lod] ${label}: ortho ${info.camera.orthoHeight.toFixed(0)} | ground textures by m/texel ${JSON.stringify(info.tiers)} ` +
      `| ≈${(bytes / 2 ** 20).toFixed(0)} MB ground | renderer textures ${info.textures}`,
  );
  return { ...info, bytes };
}

const overview = await sample('overview');
await page.evaluate(({ x, y, zoom }) => {
  window.__CITY_APP__.app.focusOnLocal(x, y);
  window.__CITY_APP__.app.setCameraSettings({ orthoHeight: zoom });
}, { x: FX, y: FY, zoom: ZOOM });
const close = await sample(`close (${FX}, ${FY})`);
await page.evaluate(() => window.__CITY_APP__.app.setCameraSettings({ orthoHeight: 2000 }));
const out = await sample('zoomed out');
const errors = await page.evaluate(() => (window.__CITY_APP__.diagnostics ?? []).filter((d) => /ground LOD/.test(d)));
await browser.close();
if (errors.length) console.log(`[lod] errors: ${errors.join(' | ')}`);
const peak = Math.max(overview.bytes, close.bytes, out.bytes);
console.log(`[lod] peak ground texture memory ≈${(peak / 2 ** 20).toFixed(0)} MB`);
process.exit(errors.length ? 1 : 0);
