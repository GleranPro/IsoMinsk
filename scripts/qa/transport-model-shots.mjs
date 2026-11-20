#!/usr/bin/env node
/**
 * Close-up QA frames for the Blender-authored transport models.
 *
 * Opens the app, pins a QA service time, follows one real bus and one real
 * tram trip and points the camera at the nearest ambient train. The frames are
 * intentionally much closer than `mobility-capture.mjs` (orthoHeight 40-70 m):
 * this is the visual acceptance pass for the new MÁZ / AKSM / ER9 models, not
 * a corridor test.
 *
 * Usage:
 *   node scripts/qa/transport-model-shots.mjs
 *   QA_GPU=1 node scripts/qa/transport-model-shots.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'screenshots', 'transport-qa');
const BASE_URL = process.env.QA_BASE_URL?.trim() || 'http://127.0.0.1:5173';
const USE_GPU = process.env.QA_GPU === '1';
const READY_TIMEOUT_MS = Number(process.env.QA_READY_TIMEOUT_MS || 180_000);
const SERVICE_DATE = process.env.QA_DATE?.trim() || '2026-11-16';
const VIEWPORT = { width: 1600, height: 900 };

const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];

async function waitForReady(page) {
  await page.waitForFunction(
    () => window.__CITY_APP__?.ready === true,
    undefined,
    { timeout: READY_TIMEOUT_MS },
  );
}

async function shot(page, name, camera) {
  await page.evaluate((settings) => {
    const handle = window.__CITY_APP__?.app;
    handle?.setCameraSettings?.(settings);
    if (Number.isFinite(settings.x) && Number.isFinite(settings.y)) {
      handle?.focusOnLocal?.(settings.x, settings.y);
    }
  }, camera);
  // Let the tile streamer load the destination and the model LOD settle.
  await page.waitForTimeout(3500);
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  const stats = await page.evaluate(() => ({
    mobility: window.__CITY_APP__?.app?.getMobilityDump?.() ?? null,
    rail: window.__CITY_DEBUG__?.rail?.() ?? null,
  }));
  console.log(`[shot] ${name} -> ${file}`);
  return stats;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: USE_GPU ? GPU_ARGS : SWIFTSHADER_ARGS,
  });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const failures = [];
  try {
    await page.goto(`${BASE_URL}/?dataset=city`, { waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    await page.waitForTimeout(1500);
    await page.evaluate((date) => {
      window.__CITY_APP__?.app?.setMobilityServiceDate?.(date, 8 * 3600);
    }, SERVICE_DATE);
    await page.waitForTimeout(2500);

    const dump = await page.evaluate(() => window.__CITY_APP__?.app?.getMobilityDump?.() ?? null);
    const trips = dump?.trips ?? [];
    const bus = trips.find((trip) => trip.mode === 'bus' && trip.phase === 'moving');
    const tram = trips.find((trip) => trip.mode === 'tram' && trip.phase === 'moving');

    if (bus) {
      const stats = await shot(page, 'bus-model-close', {
        x: bus.x,
        y: bus.y,
        orthoHeight: 42,
        azimuth: Math.PI / 4,
      });
      if (!stats.mobility?.trips?.some((trip) => trip.tripId === bus.tripId)) {
        failures.push('bus close-up: followed trip disappeared');
      }
    } else {
      failures.push('bus close-up: no active bus trip');
    }

    if (tram) {
      await shot(page, 'tram-model-close', {
        x: tram.x,
        y: tram.y,
        orthoHeight: 48,
        azimuth: Math.PI / 4,
      });
    } else {
      failures.push('tram close-up: no active tram trip');
    }

    const rail = await page.evaluate(() => window.__CITY_DEBUG__?.rail?.() ?? null);
    const train = rail?.samples?.[0];
    if (train) {
      await shot(page, 'rail-model-close', {
        x: train.x,
        y: train.y,
        orthoHeight: 75,
        azimuth: Math.PI / 4,
      });
    } else {
      failures.push('rail close-up: no ambient train samples');
    }

    const summary = {
      serviceDate: SERVICE_DATE,
      bus: bus ? { tripId: bus.tripId, x: bus.x, y: bus.y } : null,
      tram: tram ? { tripId: tram.tripId, x: tram.x, y: tram.y } : null,
      rail: rail?.samples?.slice(0, 2) ?? [],
      failures,
    };
    await writeFile(path.join(OUT_DIR, 'transport-model-shots.json'), JSON.stringify(summary, null, 2));
    if (failures.length > 0) {
      console.error(`[fatal] ${failures.length} acceptance failure(s):`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 2;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
