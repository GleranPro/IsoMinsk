/**
 * Isometric Minsk — B-2 load profile.
 *
 * Measures what "slow tile loading" is made of at the whole-city view:
 *   - how many tile JSON responses the page requested, their bytes/durations
 *   - engine stats over time (loaded/visible tiles, triangles, geometryMB, fps)
 *   - time to first geometry and to this run's sampling horizon
 *
 * Usage:
 *   node scripts/qa/b2-load-profile.mjs                # dev server at :5173
 *   QA_BASE_URL=http://127.0.0.1:5173 node ...          # explicit
 *   QA_SECONDS=120 node ...                             # sampling horizon
 *   QA_OUT=docs/B2/LOAD_PROFILE.json
 *
 * Hardware GPU is opt-in (`QA_GPU=1`); the profile itself is about loading,
 * not frame time, so the default SwiftShader is fine.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASE = process.env.QA_BASE_URL?.trim() || 'http://127.0.0.1:5173';
const SECONDS = Number(process.env.QA_SECONDS || 120);
const OUT = path.resolve(ROOT, process.env.QA_OUT || 'docs/B2/LOAD_PROFILE.json');
const USE_GPU = process.env.QA_GPU === '1';

const browser = await chromium.launch({
  headless: process.env.QA_HEADLESS !== '0',
  args: [
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    ...(USE_GPU
      ? ['--use-gl=angle', '--use-angle=d3d11']
      : ['--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const samples = [];
let firstGeometryMs = null;
let firstStatsMs = null;
const t0 = Date.now();

await page.goto(`${BASE}/?dataset=city`, { waitUntil: 'domcontentloaded' });

for (let i = 0; i < SECONDS; i += 1) {
  const sample = await page.evaluate(() => {
    const api = window.__CITY_APP__;
    const stats = window.__CITY_STATS__ ?? api?.stats;
    return stats ? { ...stats, ready: !!api?.ready } : null;
  });
  const elapsed = Date.now() - t0;
  if (sample) {
    if (firstStatsMs === null) firstStatsMs = elapsed;
    if (firstGeometryMs === null && sample.loadedTiles > 0 && sample.triangles > 0) {
      firstGeometryMs = elapsed;
    }
    samples.push({ t: elapsed, ...sample });
  }
  const last = samples.at(-1);
  if (last && last.loadedTiles >= 400) break;
  await page.waitForTimeout(1000);
}

const resources = await page.evaluate(() =>
  performance
    .getEntriesByType('resource')
    .filter((entry) => entry.name.includes('/data/city-tiles/') && entry.name.endsWith('.json'))
    .map((entry) => ({
      name: entry.name.split('/').pop(),
      transferSize: entry.transferSize,
      decodedBodySize: entry.decodedBodySize,
      duration: Math.round(entry.duration),
      startTime: Math.round(entry.startTime),
    })),
);

const tileResources = resources;
const bytes = tileResources.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0);
const durations = tileResources.map((entry) => entry.duration).sort((a, b) => a - b);
const summary = {
  base: BASE,
  gpu: USE_GPU,
  horizonSeconds: SECONDS,
  elapsedMs: Date.now() - t0,
  firstStatsMs,
  firstGeometryMs,
  tileRequests: tileResources.length,
  tileBytes: bytes,
  tileBytesMB: Math.round((bytes / 1e6) * 10) / 10,
  tileDurationMs: {
    min: durations[0] ?? null,
    p50: durations[Math.floor(durations.length / 2)] ?? null,
    p95: durations[Math.floor(durations.length * 0.95)] ?? null,
    max: durations.at(-1) ?? null,
  },
  lastStats: samples.at(-1) ?? null,
  samples,
  resourceSample: tileResources.slice(0, 10),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, samples: undefined, resourceSample: undefined }, null, 2));
console.log(`Wrote ${OUT}`);

await browser.close();
