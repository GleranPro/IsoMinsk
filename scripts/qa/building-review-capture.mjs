/**
 * L2 neighbourhood capture (locked camera before/after pairs).
 *
 * Drives the production application through `window.__CITY_APP__` with exactly
 * the camera settings frozen in `docs/building-quality/review-cases.json` and
 * records, per case and view: the case id/tile/local coordinates, the camera,
 * time of day, pixel-art settings, dataset counts, renderer, readiness and
 * console errors. The PNG evidence lands in the git-ignored
 * `screenshots/building-quality/<sha>/l2/<mode>/`.
 *
 * The `baseline` mode is run against a server whose `/data/city-tiles` is the
 * accepted pre-style dataset (tiles without `styleVariant`), and `candidate`
 * against the isolated staged styled dataset. Both runs use the same client
 * build and the same camera, so the pair differs only in the data.
 *
 * Usage:
 *   node scripts/qa/building-review-capture.mjs --cases docs/building-quality/review-cases.json \
 *        --mode candidate --base-url http://127.0.0.1:5180 --out docs/building-quality/neighborhood-results.json
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];
const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];

function parseArgs(argv) {
  const args = {
    cases: 'docs/building-quality/review-cases.json',
    mode: 'candidate',
    baseUrl: process.env.QA_BASE_URL || 'http://127.0.0.1:5180',
    out: 'docs/building-quality/neighborhood-results.json',
    maxCases: 0,
    categories: null,
    views: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--cases') args.cases = argv[++index];
    else if (value === '--mode') args.mode = argv[++index];
    else if (value === '--base-url') args.baseUrl = argv[++index];
    else if (value === '--out') args.out = argv[++index];
    else if (value === '--max-cases') args.maxCases = Number(argv[++index]);
    else if (value === '--categories') args.categories = String(argv[++index]).split(',').filter(Boolean);
    else if (value === '--views') args.views = String(argv[++index]).split(',').filter(Boolean);
  }
  return args;
}

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const casesPath = resolve(REPO_ROOT, args.cases);
  if (!existsSync(casesPath)) throw new Error(`capture: cases file missing: ${casesPath}`);
  const registry = JSON.parse(readFileSync(casesPath, 'utf8'));
  let cases = args.maxCases > 0 ? registry.cases.slice(0, args.maxCases) : registry.cases;
  if (args.categories) cases = cases.filter((item) => args.categories.includes(item.category));
  const sha = gitSha();
  const outDir = join(REPO_ROOT, 'screenshots', 'building-quality', sha, 'l2', args.mode);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: process.env.QA_GPU === '1' ? GPU_ARGS : SWIFTSHADER_ARGS,
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  const startedAt = new Date().toISOString();
  await page.goto(`${args.baseUrl}/?pixel=1&res=360&nolimit=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 180_000 });
  console.log('[capture] app ready');

  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    if (!gl) return { vendor: 'unavailable', renderer: 'unavailable' };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  });

  const dataset = await page.evaluate(async () => {
    const response = await fetch('./data/city-tiles/manifest.json');
    const manifest = await response.json();
    return {
      version: manifest.version,
      tiles: manifest.tiles?.length ?? 0,
      buildings: manifest.counts?.buildings ?? 0,
      trees: manifest.counts?.trees ?? 0,
      styleSchema: manifest.styleSchema ?? null,
      styleRunId: manifest.styleRunId ?? null,
      styleRecipeCounts: manifest.styleRecipeCounts ?? null,
      bounds: manifest.bounds,
    };
  });

  const camera = registry.capture?.camera ?? {};
  const allViews = [
    { name: 'overview-420', orthoHeight: 420, timeHours: 13, pixelArt: false },
    { name: 'close-90', orthoHeight: 90, timeHours: 13, pixelArt: false },
    { name: 'close-90-opposite', orthoHeight: 90, timeHours: 13, azimuth: 5 * Math.PI / 4, pixelArt: false },
    { name: 'night-22', orthoHeight: 90, timeHours: 22, pixelArt: true },
    { name: 'pixel-close', orthoHeight: 90, timeHours: 13, pixelArt: true },
  ];

  const views = args.views
    ? allViews.filter((view) => args.views.includes(view.name))
    : allViews;

  const rows = [];
  for (const [caseIndex, item] of cases.entries()) {
    console.log(`[capture] case ${caseIndex + 1}/${cases.length}: ${item.category}`);
    const caseRows = [];
    for (const view of views) {
      await page.evaluate(
        ({ item, view, camera }) => {
          const app = window.__CITY_APP__.app;
          app.focusOnLocal(item.localX, item.localY);
          app.setCameraSettings({
            orthoHeight: view.orthoHeight,
            azimuth: view.azimuth ?? camera.close?.azimuth ?? Math.PI / 4,
            elevation: camera.close?.elevation ?? Math.atan(1 / Math.SQRT2),
          });
          app.setTimeOfDay(view.timeHours);
          app.setPixelArt({ enabled: view.pixelArt, resolution: 360 });
        },
        { item, view, camera },
      );
      // Bounded settle: wait until the camera's visible tiles are resident (or a
      // 20 s cap), then one extra render interval. The loaded/visible counts are
      // recorded per view, so an unfinished frame is visible in the report
      // instead of being silently claimed as ready.
      const settleStart = Date.now();
      let stable = 0;
      let waited = 0;
      while (Date.now() - settleStart < 20_000) {
        const state = await page.evaluate(() => {
          const stats = window.__CITY_APP__?.stats;
          if (!stats) return { ready: false, missing: 1 };
          return { ready: true, missing: stats.visibleTiles - stats.loadedTiles };
        });
        waited = Date.now() - settleStart;
        stable = state.ready && state.missing <= 0 ? stable + 1 : 0;
        if (stable >= 3) break;
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(400);
      const ready = stable >= 3;
      const stats = await page.evaluate(() => {
        const app = window.__CITY_APP__;
        return {
          stats: app.stats,
          diagnostics: app.diagnostics.slice(-5),
          errors: app.errors.slice(-5),
          camera: app.app.getCameraSettings(),
          timeOfDay: app.app.getTimeOfDay(),
          pixelArt: app.app.getPixelArt(),
        };
      });
      console.log(`[capture]   view ${view.name} settled=${ready} waited=${waited}ms loaded=${stats.stats.loadedTiles} visible=${stats.stats.visibleTiles}`);
      const file = join(outDir, `${item.category}-${view.name}.png`);
      await page.screenshot({ path: file, fullPage: false, timeout: 120_000, animations: 'disabled' });
      caseRows.push({
        view: view.name,
        file: file.replace(`${REPO_ROOT}\\`, '').replace(`${REPO_ROOT}/`, ''),
        ready: Boolean(ready),
        camera: stats.camera,
        timeOfDay: stats.timeOfDay,
        pixelArt: stats.pixelArt,
        stats: {
          loadedTiles: stats.stats.loadedTiles,
          visibleTiles: stats.stats.visibleTiles,
          buildings: stats.stats.buildings,
          triangles: stats.stats.triangles,
          drawCalls: stats.stats.drawCalls,
          renderWidth: stats.stats.renderWidth,
          renderHeight: stats.stats.renderHeight,
        },
        diagnostics: stats.diagnostics,
        errors: stats.errors,
        status: ready && stats.errors.length === 0 ? 'pass' : 'fail',
      });
    }
    rows.push({
      category: item.category,
      id: item.id ?? null,
      tileKey: item.tileKey,
      localX: item.localX,
      localY: item.localY,
      archetype: item.archetype ?? null,
      height: item.height ?? null,
      views: caseRows,
      status: caseRows.every((row) => row.status === 'pass') ? 'pass' : 'fail',
    });
  }

  const failures = rows.filter((row) => row.status !== 'pass');
  const report = {
    schema: 1,
    generatedAt: startedAt,
    mode: args.mode,
    gitSha: sha,
    baseUrl: args.baseUrl,
    renderer,
    gpuRequested: process.env.QA_GPU === '1',
    viewport: { width: 1600, height: 900 },
    dataset,
    camera: {
      orthoHeights: [420, 90],
      azimuth: Math.PI / 4,
      oppositeAzimuth: (5 * Math.PI) / 4,
      elevation: Math.atan(1 / Math.SQRT2),
      times: { day: 13, night: 22 },
      pixelArt: { enabled: [false, true], resolution: 360 },
    },
    cases: rows,
    passedCases: rows.length - failures.length,
    failedCases: failures.map((row) => row.category),
    consoleErrors,
  };
  const outPath = resolve(REPO_ROOT, args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  await browser.close();

  console.log(
    `capture (${args.mode}): ${rows.length - failures.length}/${rows.length} cases pass; ` +
      `dataset v${dataset.version} ${dataset.tiles} tiles, styleSchema ${dataset.styleSchema}; images ${outDir}`,
  );
  if (failures.length) {
    for (const failure of failures) {
      console.error(`FAIL case ${failure.category}: ${failure.views.filter((row) => row.status !== 'pass').map((row) => row.view).join(', ')}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`capture failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
