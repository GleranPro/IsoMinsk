#!/usr/bin/env node
/**
 * Isometric Minsk — raster ground seam + timing audit (payload 0.4.0).
 *
 * Runs the real compositor (`src/city/ground/groundRaster.ts`) in Chromium with
 * a real OffscreenCanvas, through the Vite dev server (module import), on the
 * generated tiles of a dataset:
 *
 *  1. Seam check: for every pair of horizontally/vertically adjacent tiles A|B,
 *     the 32 m band on B's side of the border is painted twice — once from B's
 *     own payload and once from A's payload with its bounds shifted onto the
 *     band — and the texels are compared. Landcover polygons are clipped per
 *     tile, so both renders drop them. The strict contract is "strokes only"
 *     (strokes are clipped with a 64 m margin): a texel that differs by more
 *     than 16 levels in any channel is a visible seam. "With paint" is
 *     informational: junction faces / crossings are attached only to tiles they
 *     touch, so A legitimately lacks some of B's paint features inside B.
 *  2. Timing: full rasterisation (incl. markings) per tile, ms.
 *
 * Usage (dev server on 127.0.0.1:5173, e.g. `pnpm dev`):
 *   node scripts/qa/ground-seam-audit.mjs            # pilot
 *   QA_DATASET=city node scripts/qa/ground-seam-audit.mjs
 * Exit code 1 when any strokes-only seam band has a visible difference.
 */

import { chromium } from '@playwright/test';

const BASE_URL = process.env.QA_BASE_URL?.trim() || 'http://127.0.0.1:5173';
const DATASET = process.env.QA_DATASET === 'city' ? 'city' : 'pilot';
const MAX_DIFF_FRACTION = 0.0;

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto(`${BASE_URL}/?ground=vector`, { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(
  async ({ dataset, maxDiff }) => {
    const VISIBLE_LEVELS = 16;
    const raster = await import('/src/city/ground/groundRaster.ts');
    const base = dataset === 'city' ? '/data/city-tiles' : '/data/tiles';
    const manifest = await (await fetch(`${base}/manifest.json`, { cache: 'no-cache' })).json();
    const size = manifest.tileSize;
    const res = raster.groundResolutionFor(size);
    const tiles = new Map();
    const files = manifest.tiles.map((entry) => entry.file.replace(/^tiles\//, ''));
    const timings = [];
    for (const file of files) {
      const data = await (await fetch(`${base}/${file}`, { cache: 'no-cache' })).json();
      tiles.set(`${data.tileX}_${data.tileY}`, data);
      const t0 = performance.now();
      raster.rasterizeGround(data, data.bounds, res);
      timings.push({ key: `${data.tileX}_${data.tileY}`, ms: performance.now() - t0, strokes: data.ground?.strokes?.length ?? 0 });
      if (timings.length >= 40) break;
    }
    // Strokes-only contract: landcover and closing/median fills are attached
    // only to tiles they come within 2 m of (fills) or clipped per tile
    // (surfaces), so they are compared separately on the border strip below.
    const strip = (data) => ({ ...data, surfaces: [], ground: { ...data.ground, fills: [] } });
    const band = 32;
    const borderBand = 1.5;
    const seams = [];
    for (const [key, a] of tiles) {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        const b = tiles.get(`${a.tileX + dx}_${a.tileY + dy}`);
        if (!b) continue;
        // Band on B's side of the shared border.
        const bounds =
          dx === 1
            ? [b.bounds[0], b.bounds[1], b.bounds[0] + band, b.bounds[3]]
            : [b.bounds[0], b.bounds[1], b.bounds[2], b.bounds[1] + band];
        const compare = (markings, full = false) => {
          const area = full
            ? dx === 1
              ? [b.bounds[0], b.bounds[1], b.bounds[0] + borderBand, b.bounds[3]]
              : [b.bounds[0], b.bounds[1], b.bounds[2], b.bounds[1] + borderBand]
            : bounds;
          const prep = full ? (data) => ({ ...data, surfaces: [] }) : strip;
          const fromB = raster.rasterizeGround(prep(b), area, res, { markings });
          const fromA = raster.rasterizeGround(prep(a), area, res, { markings });
          // Visible difference only: anti-aliased stroke edges legitimately
          // differ by ±1–2 levels when a clip vertex (1 cm grid) shifts the
          // coverage computation, and Skia AA of one straight edge shifts by up to
          // ~10 levels with where the path starts (measured: a footway clipped at
          // x=576 vs passing through). > 16 levels (~6 %) is a real seam.
          let differing = 0;
          for (let i = 0; i < fromA.data.length; i += 4) {
            if (
              Math.abs(fromA.data[i] - fromB.data[i]) > VISIBLE_LEVELS ||
              Math.abs(fromA.data[i + 1] - fromB.data[i + 1]) > VISIBLE_LEVELS ||
              Math.abs(fromA.data[i + 2] - fromB.data[i + 2]) > VISIBLE_LEVELS
            ) {
              differing++;
            }
          }
          return { differing, total: fromA.data.length / 4 };
        };
        // Strokes only: the strict seam contract (64 m stroke margin).
        const strokes = compare(false);
        // With paint: informational — junction faces/crossings are attached
        // only to tiles they touch, so A legitimately lacks some of B's paint
        // features deep inside B's band.
        const paint = compare(true);
        // Border strip with the fills: the texels right at the border.
        const border = compare(false, true);
        seams.push({
          a: key,
          b: `${b.tileX}_${b.tileY}`,
          differing: strokes.differing + border.differing,
          total: strokes.total + border.total,
          fraction: Math.max(strokes.differing / strokes.total, border.differing / border.total),
          paintDiffering: paint.differing,
          borderDiffering: border.differing,
        });
      }
    }
    const worst = seams.reduce((m, s) => Math.max(m, s.fraction), 0);
    return {
      res,
      tileSize: size,
      timings,
      seams,
      worst,
      failed: seams.filter((s) => s.fraction > maxDiff).length,
    };
  },
  { dataset: DATASET, maxDiff: MAX_DIFF_FRACTION },
);

await browser.close();

const ms = result.timings.map((t) => t.ms).sort((x, y) => x - y);
console.log(`[ground] dataset=${DATASET} tileSize=${result.tileSize} res=${result.res} m/texel`);
console.log(
  `[timing] ${ms.length} tiles: median ${ms[Math.floor(ms.length / 2)].toFixed(1)} ms, ` +
    `max ${ms[ms.length - 1].toFixed(1)} ms`,
);
for (const seam of result.seams) {
  console.log(
    `[seam] ${seam.a} | ${seam.b}: strokes ${seam.differing}/${seam.total} texels differ (${(seam.fraction * 100).toFixed(3)} %), with paint ${seam.paintDiffering}, border strip incl. fills ${seam.borderDiffering}`,
  );
}
console.log(`[seam] worst ${(result.worst * 100).toFixed(3)} %, failing pairs: ${result.failed}`);
process.exit(result.failed > 0 ? 1 : 0);
