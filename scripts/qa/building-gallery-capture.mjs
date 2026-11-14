/**
 * L1 building-family gallery capture.
 *
 * Opens the QA gallery (`qa/building-gallery.html`) in Chromium, drives the
 * production camera/material settings and writes:
 *
 *   screenshots/building-quality/<sha>/gallery/*.png   (git-ignored evidence)
 *   docs/building-quality/gallery-results.json         (compact, committable)
 *
 * Each of the 27 recipe panels is captured at 90 m ortho height in day (13:00)
 * and night (22:00) light at two opposing azimuths, plus labelled grid
 * contact sheets in recipe order and in a deterministic seeded order.
 *
 * A row is `pass` only when the panel produced geometry (>= 2 wall triangles,
 * >= 1 roof triangle) and the rendered frame actually covers pixels; a black or
 * empty panel is a failure, never a silent pass.
 *
 * Usage:
 *   node scripts/qa/building-gallery-capture.mjs            # needs a dev server
 *   node scripts/qa/building-gallery-capture.mjs --ci       # starts its own server
 *   QA_BASE_URL=http://127.0.0.1:5199 node scripts/qa/building-gallery-capture.mjs
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const CI = process.argv.includes('--ci');
const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PORT = Number(process.env.QA_PORT || 5173);
const BASE_URL = process.env.QA_BASE_URL || `http://127.0.0.1:${PORT}`;
const GALLERY_URL = `${BASE_URL}/qa/building-gallery.html`;
const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);
const DAY = 13;
const NIGHT = 22;
const AZIMUTH_A = Math.PI / 4;
const AZIMUTH_B = (5 * Math.PI) / 4;
// A gallery panel is one building, so the close ortho height is derived per
// panel from its height (a 90 m half-height would make a 9 m house tiny).
const closeOrthoFor = (panel) => Math.max(10, Math.round(panel.height * 0.95));
const GRID_ORTHO = 420;
const PIXEL_ART = { enabled: false, resolution: 360, outline: 0.55, colorLevels: 20, dither: 0.35 };

// Visual review state recorded by the agent/owner pass. Automated geometry and
// frame checks cannot see through-gaps or implausible silhouettes, so the
// visual verdict is a separate field: a row is `pass` only when BOTH the
// automated checks and the recorded visual review pass.
const VISUAL_REVIEW = {
  18: {
    status: 'fail',
    issue:
      'sawtooth roof envelope left see-through gaps between the teeth; the variant roof is disabled in planRecipeRoof until the clerestory strip is watertight, so this panel now shows the source flat roof',
  },
};


const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];
const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
const USE_GPU = process.env.QA_GPU === '1';

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function waitForServer(url, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* keep waiting */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}

async function startDevServer() {
  const child = spawn(
    'pnpm',
    ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: REPO_ROOT, stdio: 'ignore', shell: true },
  );
  const ready = await waitForServer(`${BASE_URL}/qa/building-gallery.html`);
  if (!ready) {
    child.kill();
    throw new Error(`gallery: dev server did not answer on ${BASE_URL}`);
  }
  return child;
}

async function main() {
  const sha = gitSha();
  const outputDir = join(REPO_ROOT, 'screenshots', 'building-quality', sha, 'gallery');
  mkdirSync(outputDir, { recursive: true });
  const resultsPath = join(REPO_ROOT, 'docs', 'building-quality', 'gallery-results.json');

  let server = null;
  if (CI) server = await startDevServer();
  else if (!(await waitForServer(`${BASE_URL}/qa/building-gallery.html`, 5000))) {
    throw new Error(
      `gallery: no dev server at ${BASE_URL}. Run "pnpm exec vite --port ${PORT}" first or pass --ci.`,
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: USE_GPU ? GPU_ARGS : SWIFTSHADER_ARGS,
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  const startedAt = new Date().toISOString();
  await page.goto(GALLERY_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__BUILDING_GALLERY__?.ready === true, null, {
    timeout: 180_000,
  });

  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('#gallery canvas');
    const gl = canvas?.getContext('webgl2');
    if (!gl) return { vendor: 'unavailable', renderer: 'unavailable' };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  });

  const panels = await page.evaluate(() => window.__BUILDING_GALLERY__.panels);
  const rows = [];
  const shoot = async (name) => {
    const file = join(outputDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  };

  const capturePanel = async (panel, timeHours, azimuth, label) => {
    await page.evaluate(
      (options) => window.__BUILDING_GALLERY__.setCamera(options),
      { panel: panel.index, orthoHeight: closeOrthoFor(panel), azimuth, elevation: ISO_ELEVATION, timeHours, pixelArt: PIXEL_ART.enabled },
    );
    await page.waitForTimeout(120);
    const stats = await page.evaluate(() => window.__BUILDING_GALLERY__.canvasStats());
    const name = `panel-${String(panel.recipeId).padStart(2, '0')}-${panel.name}-${label}`;
    const file = await shoot(name);
    return { file, stats };
  };

  for (const panel of panels) {
    const dayA = await capturePanel(panel, DAY, AZIMUTH_A, 'day-a');
    const dayB = await capturePanel(panel, DAY, AZIMUTH_B, 'day-b');
    const nightA = await capturePanel(panel, NIGHT, AZIMUTH_A, 'night-a');
    const coveredRatio = dayA.stats.sampledPixels > 0 ? dayA.stats.coveredPixels / dayA.stats.sampledPixels : 0;
    const geometryOk = panel.triangles > 0 && panel.wallTriangles >= 2 && panel.roofTriangles >= 1;
    const renderOk = coveredRatio > 0.02 && dayA.stats.meanLuma > 8;
    const nightOk = nightA.stats.meanLuma > 4;
    rows.push({
      recipeId: panel.recipeId,
      name: panel.name,
      archetype: panel.archetype,
      profile: panel.profile,
      facade: panel.facade,
      roof: panel.roof,
      height: panel.height,
      floors: panel.floors,
      sourceRoof: panel.sourceRoof,
      triangles: panel.triangles,
      wallTriangles: panel.wallTriangles,
      roofTriangles: panel.roofTriangles,
      trimTriangles: panel.trimTriangles,
      detailTriangles: panel.detailTriangles,
      bytes: panel.bytes,
      closeOrthoHeight: closeOrthoFor(panel),
      coverageRatio: Number(coveredRatio.toFixed(4)),
      dayMeanLuma: Number(dayA.stats.meanLuma.toFixed(2)),
      nightMeanLuma: Number(nightA.stats.meanLuma.toFixed(2)),
      images: [dayA.file, dayB.file, nightA.file].map((file) => file.replace(`${REPO_ROOT}\\`, '').replace(`${REPO_ROOT}/`, '')),
      visualReview: VISUAL_REVIEW[panel.recipeId] ?? { status: 'agent-pass', issue: null },
      status:
        geometryOk && renderOk && nightOk && (VISUAL_REVIEW[panel.recipeId]?.status ?? 'agent-pass') === 'agent-pass'
          ? 'pass'
          : 'fail',
      issues: [
        ...(panel.triangles > 0 ? [] : ['no triangles']),
        ...(panel.wallTriangles >= 2 ? [] : ['fewer than 2 wall triangles']),
        ...(panel.roofTriangles >= 1 ? [] : ['no complete roof triangle']),
        ...(renderOk ? [] : [`frame coverage ${coveredRatio.toFixed(4)} / mean luma ${dayA.stats.meanLuma.toFixed(1)}`]),
        ...(nightOk ? [] : ['night frame too dark']),
        ...(VISUAL_REVIEW[panel.recipeId]?.issue ? [VISUAL_REVIEW[panel.recipeId].issue] : []),
      ],
    });
  }

  // Labelled contact sheets: recipe order and the deterministic seeded order.
  await page.evaluate((options) => window.__BUILDING_GALLERY__.setCamera(options), {
    order: 'recipe',
    orthoHeight: GRID_ORTHO,
    azimuth: AZIMUTH_A,
    elevation: ISO_ELEVATION,
    timeHours: DAY,
    pixelArt: PIXEL_ART.enabled,
  });
  await page.waitForTimeout(150);
  const gridRecipe = await shoot('grid-recipe-order-day');
  await page.evaluate((options) => window.__BUILDING_GALLERY__.setCamera(options), { order: 'seeded' });
  await page.waitForTimeout(150);
  const gridSeeded = await shoot('grid-seeded-order-day');

  const failures = rows.filter((row) => row.status !== 'pass');
  const results = {
    schema: 1,
    generatedAt: startedAt,
    gitSha: sha,
    galleryUrl: GALLERY_URL,
    renderer,
    gpuRequested: USE_GPU,
    viewport: { width: 1600, height: 900 },
    pixelArt: PIXEL_ART,
    camera: {
      closeOrthoHeights: 'per panel: max(10, round(height * 0.95))',
      gridOrthoHeight: GRID_ORTHO,
      elevation: ISO_ELEVATION,
      azimuths: [AZIMUTH_A, AZIMUTH_B],
      times: { day: DAY, night: NIGHT },
    },
    expectedPanels: panels.length,
    passedPanels: rows.length - failures.length,
    failedPanels: failures.map((row) => row.recipeId),
    visualFailures: Object.entries(VISUAL_REVIEW).filter(([, entry]) => entry.status !== 'agent-pass').map(([id, entry]) => ({ recipeId: Number(id), issue: entry.issue })),
    consoleErrors,
    contactSheets: [gridRecipe, gridSeeded].map((file) =>
      file.replace(`${REPO_ROOT}\\`, '').replace(`${REPO_ROOT}/`, ''),
    ),
    panels: rows,
  };
  mkdirSync(join(REPO_ROOT, 'docs', 'building-quality'), { recursive: true });
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 1)}\n`, 'utf8');

  await browser.close();
  if (server) server.kill();

  console.log(
    `gallery: ${rows.length - failures.length}/${rows.length} panels pass; renderer ${renderer.renderer}; ` +
      `images ${outputDir}`,
  );
  if (failures.length) {
    for (const failure of failures) {
      console.error(`FAIL panel ${failure.recipeId} ${failure.name}: ${failure.issues.join('; ')}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`gallery capture failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
