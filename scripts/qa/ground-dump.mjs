#!/usr/bin/env node
/**
 * Isometric Minsk — dump the raster ground of a world window to a PNG
 * (payload 0.4.0). Runs the real compositor in Chromium via the dev server and
 * writes the texture top-down, north up, no 3D / pixel-art post-processing, so
 * road paint can be inspected texel by texel.
 *
 * Usage (dev server on 127.0.0.1:5173):
 *   node scripts/qa/ground-dump.mjs <x> <y> [half=80] [res=0.25] [out.png]
 * x/y are local metres (same frame as the road-shots `fx`/`fy`).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [x, y] = [Number(process.argv[2]), Number(process.argv[3])];
const half = Number(process.argv[4] ?? 80);
const res = Number(process.argv[5] ?? 0.25);
const out = process.argv[6] ?? `screenshots/ground/ground_${x}_${y}.png`;
if (!Number.isFinite(x) || !Number.isFinite(y)) {
  console.error('usage: node scripts/qa/ground-dump.mjs <x> <y> [half] [res] [out.png]');
  process.exit(2);
}
const BASE_URL = process.env.QA_BASE_URL?.trim() || 'http://127.0.0.1:5173';
const DATASET = process.env.QA_DATASET === 'city' ? 'city' : 'pilot';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE_URL}/?ground=vector`, { waitUntil: 'domcontentloaded' });
const dataUrl = await page.evaluate(
  async ({ x, y, half, res, dataset }) => {
    const raster = await import('/src/city/ground/groundRaster.ts');
    const base = dataset === 'city' ? '/data/city-tiles' : '/data/tiles';
    const manifest = await (await fetch(`${base}/manifest.json`, { cache: 'no-cache' })).json();
    const size = manifest.tileSize;
    const tx = Math.floor(x / size);
    const ty = Math.floor(y / size);
    const file = manifest.tiles
      .map((entry) => entry.file.replace(/^tiles\//, ''))
      .find((name) => name === `${tx}_${ty}.json`);
    if (!file) throw new Error(`no tile ${tx}_${ty}`);
    const tile = await (await fetch(`${base}/${file}`, { cache: 'no-cache' })).json();
    const bounds = [x - half, y - half, x + half, y + half];
    const img = raster.rasterizeGround(tile, bounds, res);
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  },
  { x, y, half, res, dataset: DATASET },
);
await browser.close();
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, Buffer.from(dataUrl, 'base64'));
console.log(`[ground-dump] ${out} (${2 * half} m window at ${res} m/texel)`);
