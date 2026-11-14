/**
 * Isometric Minsk — end-to-end tests (Playwright).
 *
 * These tests drive the real Vite dev server in Chromium (WebGL2 via SwiftShader
 * in headless mode) and assert behaviour the team actually cares about:
 * the renderer becomes ready, it renders real Minsk geometry, the camera and the
 * display controls visibly change the rendered image, picking opens the info
 * panel, and no uncaught errors appear while a user interacts with the map.
 *
 * Rules for this file:
 *  - Never weak-assert. If a feature does not work, the test fails loudly.
 *  - Never retry. playwright.config.ts sets retries: 0 on purpose.
 *  - Tests that need `window.__CITY_APP__.app` fail with an explicit message
 *    when the renderer does not expose the debug global.
 *
 * Run: pnpm exec playwright test
 */

import { test, expect, type Page } from '@playwright/test';
import type {
  CameraSettings,
  CityAppHandle,
  EngineStats,
} from '../../src/shared/appApi';
import {
  resolveDataBaseUrl,
  resolveDatasetName,
  resolveManifestUrl,
  resolveTileUrl,
} from '../../src/shared/config';
import { publicAssetUrl } from '../../src/shared/assets';

/** Subset of the engine's QA debug surface used by these tests. */
interface CityDebugApi {
  datasetInfo(): {
    dataset: string;
    dataBaseUrl: string;
    manifestUrl: string;
    tileSize: number;
    defaultView: { orthoHeight: number; targetLocalX: number; targetLocalY: number };
  };
  archetypeSamples(
    archetype: string,
    limit?: number,
  ): Array<{ id: string; name: string; localX: number; localY: number; height: number }>;
}

declare global {
  interface Window {
    __CITY_APP__?: { ready?: boolean; app?: CityAppHandle; stats?: EngineStats };
    __CITY_STATS__?: EngineStats;
  }
}

/**
 * The engine's QA debug surface is declared in museum.spec.ts for the whole
 * test project; this module only needs the subset below and types it locally,
 * so no extra `Window` augmentation can conflict.
 */
type DebugWindow = Window & { __CITY_DEBUG__?: CityDebugApi };

const READY_TIMEOUT_MS = 60_000;
/** A drag/rotation/lighting change must move at least this fraction of sampled pixels. */
const IMAGE_DIFF_THRESHOLD = 0.01;
/** Console errors matching these patterns are browser noise, not app defects. */
const BENIGN_CONSOLE_ERRORS = [/favicon\.ico/i, /Failed to load resource: the server responded with a status of 404 \(Not Found\)/];

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

interface Diagnostics {
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
}

function watchPage(page: Page): Diagnostics {
  const diagnostics: Diagnostics = { consoleErrors: [], consoleWarnings: [], pageErrors: [] };
  page.on('console', (message) => {
    const type = message.type();
    if (type === 'error') diagnostics.consoleErrors.push(message.text());
    else if (type === 'warning') diagnostics.consoleWarnings.push(message.text());
  });
  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.stack || String(error));
  });
  return diagnostics;
}

function unexpectedConsoleErrors(diagnostics: Diagnostics): string[] {
  return diagnostics.consoleErrors.filter(
    (text) => !BENIGN_CONSOLE_ERRORS.some((pattern) => pattern.test(text)),
  );
}

function describeDiagnostics(diagnostics: Diagnostics): string {
  return [
    `console errors: ${JSON.stringify(diagnostics.consoleErrors, null, 2)}`,
    `page errors: ${JSON.stringify(diagnostics.pageErrors, null, 2)}`,
    `console warnings: ${JSON.stringify(diagnostics.consoleWarnings, null, 2)}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// app readiness + debug API
// ---------------------------------------------------------------------------

/**
 * Waits until the renderer is genuinely ready: `window.__CITY_APP__.ready === true`,
 * or (fallback) stats that prove city geometry is loaded. A bare
 * `window.__CITY_STATS__` object is NOT enough — the renderer emits zeroed stats
 * from its first frame before any tile has loaded.
 *
 * Fails fast when the app surfaces a fatal error, so CI reports the real cause
 * instead of waiting out the 60 s timeout.
 */
async function waitForCityReady(page: Page): Promise<'api' | 'stats'> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = await page
      .evaluate(() => {
        const api = window.__CITY_APP__;
        const stats: EngineStats | null = window.__CITY_STATS__ ?? api?.stats ?? null;
        const hasGeometry = !!stats && stats.loadedTiles > 0 && stats.triangles > 0;
        const errorElement = document.querySelector('[data-testid="error-message"]');
        return {
          apiReady: api?.ready === true,
          statsOnlyReady: !api && hasGeometry,
          hasGeometry,
          rendererError: errorElement ? (errorElement.textContent ?? '').trim() : '',
          snapshot: {
            href: location.href,
            cityAppGlobal: typeof window.__CITY_APP__,
            ready: api?.ready ?? null,
            hasAppHandle: typeof api?.app === 'object' && api?.app !== null,
            cityStatsGlobal: typeof window.__CITY_STATS__,
            stats,
            canvasCount: document.querySelectorAll('canvas').length,
            loadingOverlayClass:
              document.querySelector('[data-testid="loading-overlay"]')?.className ?? null,
          },
        };
      })
      .catch(() => null);

    if (probe) {
      if (probe.apiReady) return 'api';
      if (probe.statsOnlyReady) return 'stats';
      if (probe.rendererError) {
        throw new Error(
          `Renderer reported a fatal error before becoming ready: "${probe.rendererError}"\n` +
            `Snapshot: ${JSON.stringify(probe.snapshot, null, 2)}`,
        );
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `City app did not report ready within ${READY_TIMEOUT_MS / 1000}s.\n` +
      `Last snapshot: ${JSON.stringify(
        await page
          .evaluate(() => ({
            cityAppGlobal: typeof window.__CITY_APP__,
            ready: window.__CITY_APP__?.ready ?? null,
            hasAppHandle: typeof window.__CITY_APP__?.app === 'object' && window.__CITY_APP__?.app !== null,
            cityStatsGlobal: typeof window.__CITY_STATS__,
            stats: window.__CITY_STATS__ ?? window.__CITY_APP__?.stats ?? null,
            canvasCount: document.querySelectorAll('canvas').length,
            loadingOverlayClass:
              document.querySelector('[data-testid="loading-overlay"]')?.className ?? null,
          }))
          .catch(() => null),
        null,
        2,
      )}\n` +
      `Renderer error overlay: ${
        (await page
          .locator('[data-testid="error-message"]')
          .textContent({ timeout: 1000 })
          .catch(() => null)) ?? '(none)'
      }`,
  );
}

/** Calls a CityAppHandle method; throws a descriptive error when the handle is absent. */
async function callApp<T = unknown>(
  page: Page,
  method: keyof CityAppHandle,
  ...args: unknown[]
): Promise<T> {
  const result = await page.evaluate(
    ({
      methodName,
      methodArgs,
    }: {
      methodName: string;
      methodArgs: unknown[];
    }): { ok: true; value: unknown } | { ok: false; error: string } => {
      const handle = window.__CITY_APP__?.app;
      if (!handle) {
        return {
          ok: false,
          error:
            'window.__CITY_APP__.app is not exposed — the renderer must set window.__CITY_APP__ = { ready, app, stats }',
        };
      }
      const fn = (handle as unknown as Record<string, unknown>)[methodName];
      if (typeof fn !== 'function') {
        return { ok: false, error: `CityAppHandle.${methodName} is not a function` };
      }
      try {
        const value = (fn as (...a: unknown[]) => unknown).apply(handle, methodArgs);
        return { ok: true, value: value ?? null };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    { methodName: method as string, methodArgs: args },
  );
  if (!result.ok) throw new Error(`CityAppHandle.${String(method)} failed: ${result.error}`);
  return result.value as T;
}

async function readCamera(page: Page): Promise<CameraSettings> {
  return callApp<CameraSettings>(page, 'getCameraSettings');
}

async function readTimeOfDay(page: Page): Promise<number> {
  return callApp<number>(page, 'getTimeOfDay');
}

async function readPixelEffectEnabled(page: Page): Promise<boolean> {
  return callApp<boolean>(page, 'isPixelEffectEnabled');
}

async function readStats(page: Page): Promise<EngineStats | null> {
  return page.evaluate(() => {
    const api = window.__CITY_APP__;
    if (api?.stats && typeof api.stats === 'object') return api.stats;
    if (window.__CITY_STATS__ && typeof window.__CITY_STATS__ === 'object') {
      return window.__CITY_STATS__;
    }
    try {
      return api?.app?.getStats?.() ?? null;
    } catch {
      return null;
    }
  });
}

/** Waits two animation frames plus a settle delay so the canvas is freshly presented. */
async function settle(page: Page, delayMs = 500): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)));
      }),
  );
  await page.waitForTimeout(delayMs);
}

// ---------------------------------------------------------------------------
// canvas screenshot analysis (PNG decode happens inside the browser, no extra deps)
// ---------------------------------------------------------------------------

interface CanvasClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function canvasClip(page: Page): Promise<CanvasClip> {
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  if (box.width < 100 || box.height < 100) {
    throw new Error(`canvas is too small: ${box.width}x${box.height}`);
  }
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.floor(box.width),
    height: Math.floor(box.height),
  };
}

async function canvasScreenshot(page: Page): Promise<Buffer> {
  const clip = await canvasClip(page);
  // Generous timeout: with software WebGL the renderer can take >1 s per frame,
  // and Playwright's 15 s action timeout is not enough for a screenshot of a
  // busy 1600x900 canvas on slower machines.
  return page.screenshot({ clip, timeout: 60_000 });
}

interface ImageAnalysis {
  width: number;
  height: number;
  uniqueColors: number;
  meanLuminance: number;
  stdDevLuminance: number;
  sampledPixels: number;
}

async function analyzeImage(page: Page, png: Buffer): Promise<ImageAnalysis> {
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  return page.evaluate(async (url: string): Promise<ImageAnalysis> => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas context unavailable for screenshot analysis');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const colors = new Set<number>();
    let sum = 0;
    let sumSquares = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4 * 7) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      colors.add((r << 16) | (g << 8) | b);
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luminance;
      sumSquares += luminance * luminance;
      count += 1;
    }
    const mean = sum / count;
    return {
      width: canvas.width,
      height: canvas.height,
      uniqueColors: colors.size,
      meanLuminance: mean,
      stdDevLuminance: Math.sqrt(Math.max(sumSquares / count - mean * mean, 0)),
      sampledPixels: count,
    };
  }, dataUrl);
}

interface ImageDiff {
  ratio: number;
  differingPixels: number;
  sampledPixels: number;
}

async function imageDiffRatio(page: Page, before: Buffer, after: Buffer): Promise<ImageDiff> {
  const beforeUrl = `data:image/png;base64,${before.toString('base64')}`;
  const afterUrl = `data:image/png;base64,${after.toString('base64')}`;
  return page.evaluate(
    async ([urlA, urlB]: [string, string]): Promise<ImageDiff> => {
      const pixels = async (url: string): Promise<ImageData> => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('2D canvas context unavailable for image diff');
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      const a = await pixels(urlA);
      const b = await pixels(urlB);
      const width = Math.min(a.width, b.width);
      const height = Math.min(a.height, b.height);
      let differing = 0;
      let sampled = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const ia = (y * a.width + x) * 4;
          const ib = (y * b.width + x) * 4;
          const delta =
            Math.abs(a.data[ia] - b.data[ib]) +
            Math.abs(a.data[ia + 1] - b.data[ib + 1]) +
            Math.abs(a.data[ia + 2] - b.data[ib + 2]);
          if (delta > 18) differing += 1;
          sampled += 1;
        }
      }
      return { ratio: differing / sampled, differingPixels: differing, sampledPixels: sampled };
    },
    [beforeUrl, afterUrl] as [string, string],
  );
}

// ---------------------------------------------------------------------------
// DOM / interaction helpers
// ---------------------------------------------------------------------------

/** React-safe setter for a controlled <input type="range">. Returns the new value. */
async function setSliderValue(page: Page, testId: string, value: number): Promise<string> {
  const result = await page.evaluate(
    ({ id, nextValue }: { id: string; nextValue: number }): { ok: boolean; value?: string; error?: string } => {
      const selector = `[data-testid="${id}"]`;
      const slider = document.querySelector(selector);
      if (!(slider instanceof HTMLInputElement)) {
        return { ok: false, error: `element ${selector} not found or not an <input>` };
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) return { ok: false, error: 'native input value setter unavailable' };
      setter.call(slider, String(nextValue));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: slider.value };
    },
    { id: testId, nextValue: value },
  );
  if (!result.ok) throw new Error(`setSliderValue(${testId}) failed: ${result.error}`);
  return result.value ?? '';
}

async function clickCanvasCenter(page: Page): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function dragCanvas(page: Page, deltaX: number, deltaY: number, button: 'left' | 'right' = 'left') {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button });
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 15 });
  await page.mouse.up({ button });
}

/**
 * Waits until the document has actually executed its JS (React mounted or the
 * debug globals exist). A dev server that reloads modules mid-save can serve a
 * document that never boots; that state is indistinguishable from a hard crash
 * at the page level, so callers should reload once and then fail loudly if it
 * persists.
 */
async function waitForDocumentBoot(page: Page, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const booted = await page
      .evaluate(() => ({
        canvases: document.querySelectorAll('canvas').length,
        hasCityGlobal: typeof window.__CITY_APP__ !== 'undefined',
        rootChildren: document.getElementById('root')?.childElementCount ?? 0,
      }))
      .catch(() => null);
    if (booted && (booted.canvases > 0 || booted.hasCityGlobal || booted.rootChildren > 0)) {
      return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

/** Opens the app and waits for the renderer. Returns diagnostics collected from page load. */
async function openApp(page: Page, path = '/'): Promise<Diagnostics> {
  const diagnostics = watchPage(page);
  await page.goto(path);
  // Bounded infrastructure retry: if the document never executed (Vite reloaded
  // modules while another agent saved files), reload once. This cannot mask an
  // application bug: a real crash still fails on the reload attempt and is
  // reported with its console/page errors.
  const booted = await waitForDocumentBoot(page);
  if (!booted) {
    console.warn(
      '[qa] document did not boot within 10 s (likely a dev-server reload while files were being saved) — reloading once',
    );
    test.info().annotations.push({
      type: 'document-boot-retry',
      description: 'page did not execute JS within 10 s; reloaded once',
    });
    await page.reload();
  }
  await waitForCityReady(page);
  return diagnostics;
}

/**
 * A building candidate taken from the *loaded* complete-city tiles: footprint
 * centroid in local metres plus the data needed to describe it in diagnostics.
 */
interface BuildingCandidate {
  id: string;
  archetype: string;
  height: number;
  x: number;
  y: number;
  distance: number;
}

/**
 * Finds a building in the *real* streamed city data so the pick test can aim
 * the camera at a known building instead of blind-clicking.
 *
 * The public payload is the complete city (437 tiles), so the old helper that
 * downloaded every tile from the test is no longer viable. The engine already
 * has those same real OSM features resident: its QA debug surface exposes
 * per-archetype samples with footprint centroids. We poll briefly because the
 * resident set grows from the initial 48 tiles towards the full city after
 * load; `?dataset=` legacy links are irrelevant here (there is only one
 * dataset), and no fixture data is fabricated.
 */
async function findClickableBuilding(page: Page): Promise<BuildingCandidate> {
  const deadline = Date.now() + 60_000;
  let lastError = 'the engine did not expose any loaded residential building';
  while (Date.now() < deadline) {
    const target = await page.evaluate(() => {
      const debug = (window as DebugWindow).__CITY_DEBUG__;
      if (!debug) return { error: 'window.__CITY_DEBUG__ is not exposed by the engine' };
      const info = debug.datasetInfo();
      const centreX = info.defaultView.targetLocalX;
      const centreY = info.defaultView.targetLocalY;

      // Prefer the archetypes the previous test used (dense, mid-rise, flat
      // roofs are reliable click targets), then fall back to any loaded
      // building archetype so a sparse loaded set cannot fail the test.
      const priority = ['khrushchev', 'panel', 'stalin', 'historic', 'office', 'modern', 'small'];
      for (const archetype of priority) {
        const samples = debug.archetypeSamples(archetype, 240);
        if (samples.length === 0) continue;
        let best: BuildingCandidate | null = null;
        for (const sample of samples) {
          if (!(sample.height >= 8 && sample.height <= 60)) continue;
          const distance = Math.hypot(sample.localX - centreX, sample.localY - centreY);
          if (!best || distance < best.distance) {
            best = {
              id: sample.id,
              archetype,
              height: sample.height,
              x: sample.localX,
              y: sample.localY,
              distance,
            };
          }
        }
        if (best) return best;
        // The archetype exists but has no mid-rise member loaded yet; keep
        // looking rather than reporting a spurious failure.
      }
      return {
        error: `no loaded building with a valid footprint in the priority list (${priority.join(', ')})`,
      };
    });
    if (!('error' in target)) return target;
    lastError = String(target.error);
    await page.waitForTimeout(500);
  }
  throw new Error(`Cannot locate a building from the loaded complete-city data: ${lastError}`);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// public payload contract: the complete city only, below the deployment path
// ---------------------------------------------------------------------------

test.describe('Isometric Minsk — complete-city public payload', () => {
  /**
   * The public application serves exactly one payload: the complete city. No
   * query parameter can select the pilot/staging dataset, every endpoint is
   * project-relative (so GitHub Pages can serve it below /VoxelMinsk/), and the
   * legacy `?dataset=` links keep working by resolving to that same city.
   */
  const LEGACY_SEARCHES = ['', '?dataset=city', '?dataset=central', '?dataset=potato'];

  test('0. resolver always selects the complete city for legacy links', () => {
    for (const search of LEGACY_SEARCHES) {
      expect(resolveDatasetName(search), `dataset for "${search}"`).toBe('city');
      expect(resolveDataBaseUrl(search), `data base for "${search}"`).toBe('./data/city-tiles');
      expect(resolveManifestUrl(search), `manifest for "${search}"`).toBe(
        './data/city-tiles/manifest.json',
      );
      expect(resolveTileUrl('tiles/-11_-9.json', search), `tile for "${search}"`).toBe(
        './data/city-tiles/-11_-9.json',
      );
    }
    // GitHub Pages serves the project below /VoxelMinsk/: the same helper must
    // carry that prefix instead of a host-root path.
    expect(publicAssetUrl('data/city-tiles', '/VoxelMinsk/')).toBe('/VoxelMinsk/data/city-tiles');
  });

  test('1. legacy ?dataset=central renders the complete city from relative data URLs', async ({ page }) => {
    test.setTimeout(180_000);
    const dataRequestPaths: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.includes('/data/')) dataRequestPaths.push(pathname);
    });

    const diagnostics = await openApp(page, '/?dataset=central');
    // The HUD renders its payload summary once the manifest request resolves.
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="data-note"]')?.textContent?.trim()),
      null,
      { timeout: 30_000 },
    );
    const pageDirectory = await page.evaluate(() => location.pathname.replace(/[^/]*$/, ''));

    const contract = await page.evaluate(async () => {
      const debug = (window as DebugWindow).__CITY_DEBUG__;
      const info = debug?.datasetInfo() ?? null;
      const response = await fetch('./data/city-tiles/manifest.json', { cache: 'no-cache' });
      const manifest = response.ok ? await response.json() : null;
      const tiles = Array.isArray(manifest?.tiles) ? manifest.tiles : [];
      return {
        info,
        status: response.status,
        tiles: tiles.length,
        buildings: manifest?.counts?.buildings ?? 0,
        tileSize: manifest?.tileSize ?? 0,
        bounds: Array.isArray(manifest?.bounds)
          ? (manifest.bounds as [number, number, number, number])
          : null,
        firstTileFile: (tiles[0] as { file?: string } | undefined)?.file ?? '',
        dataNote: document.querySelector('[data-testid="data-note"]')?.textContent?.trim() ?? '',
        subtitle: document.querySelector('[data-testid="app-subtitle"]')?.textContent?.trim() ?? '',
        loadingText: document.querySelector('[data-testid="loading-overlay"]')?.textContent ?? '',
      };
    });

    expect(contract.info, 'window.__CITY_DEBUG__.datasetInfo()').not.toBeNull();
    expect(contract.info?.dataset, 'active dataset').toBe('city');
    expect(contract.info?.dataBaseUrl, 'data base URL').toBe('./data/city-tiles');
    expect(contract.info?.manifestUrl, 'manifest URL').toBe('./data/city-tiles/manifest.json');

    expect(contract.status, 'manifest HTTP status').toBe(200);
    expect(contract.tiles, 'manifest tile count').toBeGreaterThan(100);
    expect(contract.buildings, 'manifest building count').toBeGreaterThan(10_000);

    // The HUD must report the payload's own complete-city counts, not a pilot.
    const reportedBuildings = Number(
      (contract.dataNote.match(/^([\d,\s]+) buildings/) ?? [])[1]?.replace(/[^\d]/g, ''),
    );
    expect(reportedBuildings, `data-note building count (${contract.dataNote})`).toBe(
      contract.buildings,
    );
    expect(contract.dataNote, 'data-note tile count').toContain(`${contract.tiles} tiles`);
    expect(contract.dataNote, 'data-note grid').toContain(`${contract.tileSize} m grid`);
    expect(contract.subtitle, 'subtitle').toContain('whole city');
    expect(contract.subtitle, 'subtitle').not.toContain('central district');
    expect(contract.loadingText, 'loading overlay').toContain('whole city');
    expect(contract.loadingText, 'loading overlay').not.toContain('central');

    // The initial camera fits the complete-city bounds, never a 1.6 km pilot
    // subset: a pilot framing would be ~600 m high and hide the outer tiles.
    const bounds = contract.bounds;
    if (!bounds) throw new Error('manifest bounds are missing');
    const [minX, minY, maxX, maxY] = bounds;
    expect(contract.info?.defaultView.targetLocalX, 'initial view centre x').toBeCloseTo(
      (minX + maxX) / 2,
      0,
    );
    expect(contract.info?.defaultView.targetLocalY, 'initial view centre y').toBeCloseTo(
      (minY + maxY) / 2,
      0,
    );
    expect(contract.info?.defaultView.orthoHeight, 'initial view ortho height').toBeGreaterThan(
      4_000,
    );

    // The first tile is resolved through the single public resolver and lives
    // directly under the project-relative data base.
    expect(contract.firstTileFile).toMatch(/^tiles\//);
    const firstTileUrl = resolveTileUrl(contract.firstTileFile);
    expect(firstTileUrl).toBe(
      `./data/city-tiles/${contract.firstTileFile.replace(/^tiles\//, '')}`,
    );
    const firstTile = await page.evaluate(async (url) => {
      const response = await fetch(url, { cache: 'no-cache' });
      return { status: response.status, bytes: (await response.text()).length };
    }, firstTileUrl);
    expect(firstTile.status, `first tile HTTP status (${firstTileUrl})`).toBe(200);
    expect(firstTile.bytes, 'first tile bytes').toBeGreaterThan(1_000);

    // The museum payload resolves below the same project-relative base.
    const museum = await page.evaluate(
      async ([manifestPath, binaryPath]: [string, string]) => {
        const [manifestResponse, binaryResponse] = await Promise.all([
          fetch(manifestPath, { cache: 'no-cache' }),
          fetch(binaryPath, { cache: 'no-cache' }),
        ]);
        return {
          manifest: manifestResponse.status,
          binary: binaryResponse.status,
          binaryBytes: binaryResponse.ok ? (await binaryResponse.arrayBuffer()).byteLength : 0,
        };
      },
      [
        publicAssetUrl('data/museum/manifest.json'),
        publicAssetUrl('data/museum/exhibits.bin'),
      ] as [string, string],
    );
    expect(museum.manifest, 'museum manifest HTTP status').toBe(200);
    expect(museum.binary, 'museum exhibits HTTP status').toBe(200);
    expect(museum.binaryBytes, 'museum exhibits bytes').toBeGreaterThan(100_000);

    // Every observed data request stayed below the application directory: no
    // host-root /data/tiles pilot request, no alternate/reduced dataset.
    expect(dataRequestPaths.length, 'observed data requests').toBeGreaterThan(0);
    for (const requestPath of dataRequestPaths) {
      expect(requestPath.startsWith('/data/tiles/'), `root pilot request: ${requestPath}`).toBe(
        false,
      );
      expect(requestPath.includes('city-tiles-current'), `staging request: ${requestPath}`).toBe(
        false,
      );
      expect(requestPath.includes('city-tiles-b2'), `staging request: ${requestPath}`).toBe(false);
      const belowAppDirectory =
        requestPath.startsWith(`${pageDirectory}data/city-tiles/`) ||
        requestPath.startsWith(`${pageDirectory}data/museum/`);
      expect(belowAppDirectory, `data request outside the app directory: ${requestPath}`).toBe(
        true,
      );
    }

    expect(unexpectedConsoleErrors(diagnostics), describeDiagnostics(diagnostics)).toEqual([]);
    expect(diagnostics.pageErrors, describeDiagnostics(diagnostics)).toEqual([]);
  });
});

test.describe('Isometric Minsk — shell and renderer readiness', () => {
  test('1. app shell loads with a non-zero WebGL canvas and no console/page errors', async ({ page }) => {
    const diagnostics = await openApp(page);

    await expect(page.locator('h1')).toHaveText(/isometric minsk/i);

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    expect(box.width, 'canvas width').toBeGreaterThan(100);
    expect(box.height, 'canvas height').toBeGreaterThan(100);

    const readySource = await page.evaluate(() =>
      window.__CITY_APP__?.ready === true ? ('api' as const) : ('stats' as const),
    );
    test.info().annotations.push({ type: 'ready-source', description: readySource });

    // The loading overlay must disappear once the renderer is ready.
    await expect
      .poll(
        () =>
          page
            .locator('[data-testid="loading-overlay"]')
            .evaluate((element) => element.classList.contains('hidden'))
            .catch(() => false),
        { timeout: 10_000, message: 'loading overlay should be hidden after ready' },
      )
      .toBe(true);

    await settle(page, 750);

    expect(unexpectedConsoleErrors(diagnostics), describeDiagnostics(diagnostics)).toEqual([]);
    expect(diagnostics.pageErrors, describeDiagnostics(diagnostics)).toEqual([]);
  });

  test('2. exposes window.__CITY_APP__ = { ready, app, stats } within 60 s', async ({ page }) => {
    const diagnostics = await openApp(page);

    await page.waitForFunction(() => window.__CITY_APP__?.ready === true, undefined, {
      timeout: READY_TIMEOUT_MS,
      polling: 200,
    });

    const shape = await page.evaluate(() => {
      const api = window.__CITY_APP__;
      const handle = api?.app as unknown as Record<string, unknown> | undefined;
      const requiredMethods = [
        'start',
        'stop',
        'dispose',
        'resetCamera',
        'getCameraSettings',
        'setCameraSettings',
        'focusOnLocal',
        'setPixelArt',
        'getPixelArt',
        'setTimeOfDay',
        'getTimeOfDay',
        'setFacadeDetail',
        'setDebugWireframe',
        'setPixelEffectEnabled',
        'isPixelEffectEnabled',
        'loadAreaAround',
        'getStats',
        'clearSelection',
        'highlightBuilding',
      ];
      return {
        ready: api?.ready ?? null,
        hasAppHandle: !!handle,
        methods: Object.fromEntries(
          requiredMethods.map((name) => [name, typeof handle?.[name] === 'function']),
        ),
        hasAppStats: !!api?.stats,
        hasStatsGlobal: typeof window.__CITY_STATS__ === 'object' && window.__CITY_STATS__ !== null,
        statsSnapshot: api?.stats ?? window.__CITY_STATS__ ?? null,
      };
    });

    expect(shape.ready, 'window.__CITY_APP__.ready').toBe(true);
    expect(shape.hasAppHandle, 'window.__CITY_APP__.app (CityAppHandle)').toBe(true);
    const missingMethods = Object.entries(shape.methods)
      .filter(([, present]) => !present)
      .map(([name]) => name);
    expect(missingMethods, 'CityAppHandle methods missing from the exposed handle').toEqual([]);
    expect(shape.hasAppStats || shape.hasStatsGlobal, 'EngineStats exposed').toBe(true);

    await page.waitForFunction(
      () => {
        const stats = window.__CITY_APP__?.stats ?? window.__CITY_STATS__;
        return !!stats && typeof stats.triangles === 'number' && stats.triangles > 0;
      },
      undefined,
      { timeout: 30_000, polling: 250 },
    );

    expect(unexpectedConsoleErrors(diagnostics), describeDiagnostics(diagnostics)).toEqual([]);
  });

  test('3. renders real Minsk geometry (triangles > 1000 and buildings > 100)', async ({ page }) => {
    await openApp(page);

    await page.waitForFunction(
      () => {
        const stats = window.__CITY_APP__?.stats ?? window.__CITY_STATS__;
        return !!stats && stats.triangles > 1000 && stats.buildings > 100;
      },
      undefined,
      { timeout: READY_TIMEOUT_MS, polling: 250 },
    );

    const stats = await readStats(page);
    expect(stats, 'EngineStats').not.toBeNull();
    if (!stats) throw new Error('EngineStats are not available');
    console.log(`[qa] EngineStats: ${JSON.stringify(stats)}`);

    expect(stats.triangles, 'rendered triangles').toBeGreaterThan(1000);
    expect(stats.buildings, 'loaded buildings').toBeGreaterThan(100);
    expect(stats.loadedTiles, 'loaded tiles').toBeGreaterThan(0);
    expect(stats.drawCalls, 'draw calls').toBeGreaterThan(0);
    expect(stats.renderWidth, 'render width').toBeGreaterThan(0);
  });

  test('4. canvas contains a real rendered image (non-uniform pixels)', async ({ page }) => {
    await openApp(page);
    await page.waitForFunction(
      () => {
        const stats = window.__CITY_APP__?.stats ?? window.__CITY_STATS__;
        return !!stats && stats.triangles > 1000;
      },
      undefined,
      { timeout: READY_TIMEOUT_MS },
    );
    await settle(page, 1000);

    const png = await canvasScreenshot(page);
    const analysis = await analyzeImage(page, png);
    console.log(`[qa] canvas image analysis: ${JSON.stringify(analysis)}`);

    // A flat-coloured canvas would have 1–2 unique colours and ~0 luminance spread.
    expect(
      analysis.uniqueColors,
      `canvas should not be a flat colour; analysis=${JSON.stringify(analysis)}`,
    ).toBeGreaterThanOrEqual(16);
    expect(
      analysis.stdDevLuminance,
      `canvas luminance spread is implausibly low; analysis=${JSON.stringify(analysis)}`,
    ).toBeGreaterThan(4);
    expect(analysis.meanLuminance, 'canvas mean luminance (not pure black)').toBeGreaterThan(5);
    expect(analysis.meanLuminance, 'canvas mean luminance (not pure white)').toBeLessThan(250);
  });
});

test.describe('Isometric Minsk — camera interaction', () => {
  test('5. mouse-drag pan changes the rendered image', async ({ page }) => {
    const diagnostics = await openApp(page);
    await settle(page, 800);

    const before = await canvasScreenshot(page);
    await dragCanvas(page, 180, 120);
    await settle(page, 800);
    const after = await canvasScreenshot(page);

    const diff = await imageDiffRatio(page, before, after);
    console.log(`[qa] pan image diff: ${JSON.stringify(diff)}`);
    expect(
      diff.ratio,
      `panning the map must change the rendered image (diff=${JSON.stringify(diff)})`,
    ).toBeGreaterThan(IMAGE_DIFF_THRESHOLD);

    expect(unexpectedConsoleErrors(diagnostics), describeDiagnostics(diagnostics)).toEqual([]);
    expect(diagnostics.pageErrors, describeDiagnostics(diagnostics)).toEqual([]);
  });

  test('6. mouse wheel zoom changes the orthographic camera height', async ({ page }) => {
    await openApp(page);
    const before = await readCamera(page);

    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);

    await expect
      .poll(async () => (await readCamera(page)).orthoHeight, {
        timeout: 10_000,
        message: 'wheel zoom should change CameraSettings.orthoHeight',
      })
      .not.toBe(before.orthoHeight);

    const after = await readCamera(page);
    console.log(
      `[qa] orthoHeight ${before.orthoHeight.toFixed(1)} -> ${after.orthoHeight.toFixed(1)}`,
    );
    expect(after.orthoHeight, 'zoom in should shrink orthoHeight').toBeLessThan(before.orthoHeight);

    // Reset for the next interaction in this browser page.
    await callApp(page, 'setCameraSettings', { orthoHeight: before.orthoHeight });
  });

  test('7. rotation changes the camera azimuth', async ({ page }) => {
    await openApp(page);
    const before = await readCamera(page);

    await callApp(page, 'setCameraSettings', { azimuth: before.azimuth + Math.PI / 2 });
    const after = await readCamera(page);

    expect(after.azimuth).toBeCloseTo(before.azimuth + Math.PI / 2, 4);
    console.log(`[qa] azimuth ${before.azimuth.toFixed(3)} -> ${after.azimuth.toFixed(3)} rad`);

    // Right-drag is the user-facing rotation gesture; it must move the azimuth too.
    const beforeDrag = await readCamera(page);
    await dragCanvas(page, -220, 0, 'right');
    await expect
      .poll(async () => (await readCamera(page)).azimuth, {
        timeout: 10_000,
        message: 'right-drag rotation should change CameraSettings.azimuth',
      })
      .not.toBe(beforeDrag.azimuth);
  });
});

test.describe('Isometric Minsk — display controls', () => {
  test('8. time-of-day slider changes the rendered image', async ({ page }) => {
    await openApp(page);
    await settle(page, 800);

    const slider = page.locator('[data-testid="time-slider"]');
    await expect(slider, 'time-of-day slider must exist').toBeVisible();

    const before = await canvasScreenshot(page);
    const setValue = await setSliderValue(page, 'time-slider', 23);
    expect(setValue, 'slider DOM value after setting').toBe('23');

    await expect
      .poll(async () => readTimeOfDay(page), {
        timeout: 10_000,
        message: 'app.getTimeOfDay() should follow the slider',
      })
      .toBeCloseTo(23, 1);

    await settle(page, 900);
    await expect(page.locator('[data-testid="time-label"]')).toHaveText('23:00');
    const after = await canvasScreenshot(page);

    const diff = await imageDiffRatio(page, before, after);
    console.log(`[qa] time-of-day image diff: ${JSON.stringify(diff)}`);
    expect(
      diff.ratio,
      `switching from 13:00 to 23:00 must change the rendered image (diff=${JSON.stringify(diff)})`,
    ).toBeGreaterThan(0.02);
  });

  test('9. pixel-effect toggle changes the rendered image', async ({ page }) => {
    await openApp(page);
    await settle(page, 800);

    expect(await readPixelEffectEnabled(page), 'pixel effect starts enabled').toBe(true);
    const before = await canvasScreenshot(page);

    await page.locator('[data-testid="toggle-pixel"]').click();
    await expect
      .poll(async () => readPixelEffectEnabled(page), {
        timeout: 10_000,
        message: 'pixel effect toggle must reach the renderer',
      })
      .toBe(false);

    await settle(page, 900);
    const after = await canvasScreenshot(page);

    const diff = await imageDiffRatio(page, before, after);
    console.log(`[qa] pixel-effect image diff: ${JSON.stringify(diff)}`);
    expect(
      diff.ratio,
      `disabling the pixel-art effect must change the rendered image (diff=${JSON.stringify(diff)})`,
    ).toBeGreaterThan(0.02);

    // Restore and verify the toggle round-trips.
    await page.locator('[data-testid="toggle-pixel"]').click();
    await expect.poll(async () => readPixelEffectEnabled(page), { timeout: 10_000 }).toBe(true);
  });
});

test.describe('Isometric Minsk — selection and stability', () => {
  test('10. clicking a building opens the info panel with real OSM data', async ({ page }) => {
    await openApp(page);

    // Aim the camera at a building we know exists in the streamed complete city.
    const target = await findClickableBuilding(page);
    await callApp(page, 'focusOnLocal', target.x, target.y);
    await callApp(page, 'setCameraSettings', { orthoHeight: 110 });
    await settle(page, 900);

    const infoPanel = page.locator('[data-testid="info-panel"], .info-panel').first();
    await clickCanvasCenter(page);
    let visible = await infoPanel
      .isVisible({ timeout: 2_500 })
      .catch(() => false);

    // Fallback: scan a grid of points over the map (HUD panels sit at the edges).
    if (!visible) {
      const box = await page.locator('canvas').first().boundingBox();
      if (!box) throw new Error('canvas has no bounding box');
      const fractions = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65];
      for (const fx of fractions) {
        for (const fy of [0.45, 0.55, 0.35, 0.65, 0.5]) {
          await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
          visible = await infoPanel.isVisible({ timeout: 700 }).catch(() => false);
          if (visible) break;
        }
        if (visible) break;
      }
    }

    expect(visible, 'clicking a building should open the building info panel').toBe(true);

    const osmId = page.locator('[data-testid="info-osm-id"], .info-panel [data-testid="info-osm-id"]').first();
    await expect(osmId, 'info panel should show the OSM id').toBeVisible();
    const osmIdText = (await osmId.textContent())?.trim() ?? '';
    expect(osmIdText, `OSM id text (${osmIdText})`).toMatch(/^[wr]\d+$/);

    const panelText = (await infoPanel.textContent()) ?? '';
    expect(panelText, 'info panel should report a height').toMatch(/Height/);
    console.log(`[qa] selected building: ${osmIdText} (aimed at ${target.archetype} ${target.id})`);

    // Closing the panel must work.
    const closeButton = page.locator('[data-testid="info-panel"] .close, .info-panel .close').first();
    await closeButton.click();
    await expect(infoPanel).toBeHidden({ timeout: 5_000 });
  });

  test('11. no uncaught errors during 5 s of interaction', async ({ page }) => {
    const diagnostics = await openApp(page);
    await settle(page, 500);

    await dragCanvas(page, 150, -90);
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await setSliderValue(page, 'time-slider', 18);
    await page.locator('[data-testid="toggle-pixel"]').click();
    await page.locator('[data-testid="toggle-pixel"]').click();
    await page.locator('[data-testid="toggle-wireframe"]').click();
    await page.locator('[data-testid="toggle-wireframe"]').click();
    await clickCanvasCenter(page);
    await page.keyboard.down('q');
    await page.waitForTimeout(400);
    await page.keyboard.up('q');
    await page.keyboard.press('Escape');

    await page.waitForTimeout(5_000);

    expect(diagnostics.pageErrors, `uncaught page errors: ${describeDiagnostics(diagnostics)}`).toEqual(
      [],
    );
    expect(
      unexpectedConsoleErrors(diagnostics),
      `console errors during interaction: ${describeDiagnostics(diagnostics)}`,
    ).toEqual([]);

    // The app must still be alive and ready after the interaction burst.
    expect(await page.evaluate(() => window.__CITY_APP__?.ready === true)).toBe(true);
    const stats = await readStats(page);
    expect(stats?.triangles ?? 0, 'renderer still drawing after interaction').toBeGreaterThan(1000);
  });

  test('12. page reload re-renders the city', async ({ page }) => {
    await openApp(page);
    await page.waitForFunction(
      () => {
        const stats = window.__CITY_APP__?.stats ?? window.__CITY_STATS__;
        return !!stats && stats.triangles > 1000;
      },
      undefined,
      { timeout: READY_TIMEOUT_MS },
    );

    const diagnostics = watchPage(page);
    await page.reload();
    await waitForCityReady(page);
    await expect(page.locator('h1')).toHaveText(/isometric minsk/i);

    await page.waitForFunction(
      () => {
        const stats = window.__CITY_APP__?.stats ?? window.__CITY_STATS__;
        return !!stats && stats.triangles > 1000 && stats.buildings > 100;
      },
      undefined,
      { timeout: READY_TIMEOUT_MS, polling: 250 },
    );

    await settle(page, 900);
    const png = await canvasScreenshot(page);
    const analysis = await analyzeImage(page, png);
    expect(
      analysis.uniqueColors,
      `canvas after reload should render the city; analysis=${JSON.stringify(analysis)}`,
    ).toBeGreaterThanOrEqual(16);

    expect(unexpectedConsoleErrors(diagnostics), describeDiagnostics(diagnostics)).toEqual([]);
    expect(diagnostics.pageErrors, describeDiagnostics(diagnostics)).toEqual([]);
  });
});
