#!/usr/bin/env node
/**
 * Isometric Minsk — quantitative analysis of the captured screenshots.
 *
 * The capture script produces PNGs; this tool turns them into numbers that make
 * visual QA reviewable in a diffable text file instead of "looks fine to me".
 * It decodes each PNG inside a headless Chromium page (no image dependencies)
 * and reports luminance distribution, colour counts and the non-background
 * bounding box.
 *
 * Output: screenshots/analysis.json + a table on stdout.
 *
 * Usage: node scripts/qa/analyze-screenshots.mjs
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SHOTS_DIR = path.join(ROOT, 'screenshots');

const CANONICAL_SHOTS = [
  '01-overview.png',
  '02-closeup-residential.png',
  '03-closeup-landmark.png',
  '04-night.png',
  '05-clean-3d.png',
  '06-rotated.png',
];

const allPngs = (await readdir(SHOTS_DIR).catch(() => []))
  .filter((name) => name.toLowerCase().endsWith('.png'))
  .sort();

// Other agents also drop PNGs into screenshots/; analyse only the canonical
// capture set by default so their files cannot pollute the metrics or race with
// a write. Use QA_ANALYZE_ALL=1 to include everything.
const pngFiles =
  process.env.QA_ANALYZE_ALL === '1'
    ? allPngs
    : allPngs.filter((name) => CANONICAL_SHOTS.includes(name));

if (pngFiles.length === 0) {
  console.error(
    `No canonical screenshots (${CANONICAL_SHOTS.join(', ')}) found in ${SHOTS_DIR}. ` +
      'Run scripts/qa/capture.mjs first.',
  );
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();

const results = [];
for (const file of pngFiles) {
  const buffer = await readFile(path.join(SHOTS_DIR, file));
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  const metrics = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D context unavailable');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);

    const colours = new Map();
    let sum = 0;
    let sumSquares = 0;
    let nearBlack = 0;
    let nearWhite = 0;
    let count = 0;
    // Bounding box of pixels that differ notably from the most common colour
    // (the dominant background: sky or missing ground).
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let i = 0; i < data.length; i += 4 * 5) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = `${r},${g},${b}`;
      colours.set(key, (colours.get(key) ?? 0) + 1);
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luminance;
      sumSquares += luminance * luminance;
      if (luminance < 8) nearBlack += 1;
      if (luminance > 245) nearWhite += 1;
      count += 1;
    }
    const mean = sum / count;
    const dominant = [...colours.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const [dr, dg, db] = dominant.split(',').map(Number);
    const stride = 5 * 4;
    for (let i = 0, pixel = 0; i < data.length; i += stride, pixel += 5) {
      const diff =
        Math.abs(data[i] - dr) + Math.abs(data[i + 1] - dg) + Math.abs(data[i + 2] - db);
      if (diff > 24) {
        // Reconstruct approximate x/y from the byte offset (width known).
        const index = i / 4;
        const x = index % canvas.width;
        const y = Math.floor(index / canvas.width);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      uniqueColors: colours.size,
      dominantColor: dominant,
      dominantShare: (colours.get(dominant) ?? 0) / count,
      meanLuminance: mean,
      stdDevLuminance: Math.sqrt(Math.max(sumSquares / count - mean * mean, 0)),
      nearBlackShare: nearBlack / count,
      nearWhiteShare: nearWhite / count,
      contentBBox:
        maxX >= 0
          ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
          : null,
    };
  }, dataUrl).catch((error) => ({ error: String(error) }));
  results.push({ file, bytes: buffer.length, ...metrics });
  const percent = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—');
  console.log(
    `${file.padEnd(28)} ${String(metrics.width ?? '?').padStart(4)}x${String(metrics.height ?? '?').padEnd(4)} ` +
      `colors=${String(metrics.uniqueColors ?? '?').padStart(5)} ` +
      `lum=${(metrics.meanLuminance ?? 0).toFixed(1).padStart(6)} ` +
      `black=${percent(metrics.nearBlackShare).padStart(6)} ` +
      `white=${percent(metrics.nearWhiteShare).padStart(6)} ` +
      `content=${metrics.contentBBox ? `${metrics.contentBBox.width}x${metrics.contentBBox.height}` : '—'}`,
  );
}

await writeFile(
  path.join(SHOTS_DIR, 'analysis.json'),
  JSON.stringify(
    {
      analyzedAt: new Date().toISOString(),
      note: 'Generated by scripts/qa/analyze-screenshots.mjs. nearBlackShare is the fraction of sampled pixels with luminance < 8/255; a city map should not be mostly black.',
      screenshots: results,
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`\nWrote ${path.join(SHOTS_DIR, 'analysis.json')}`);
await browser.close();
