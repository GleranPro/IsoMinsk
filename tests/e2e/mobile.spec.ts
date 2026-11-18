/**
 * Mobile / touch end-to-end tests (Playwright, Chromium, emulated phone).
 *
 * These drive real touch input through the Chrome DevTools Protocol — not
 * synthetic PointerEvents — so the browser's touch → pointer pipeline,
 * `touch-action: none` handling and multi-pointer delivery are all exercised.
 *
 * Coverage:
 *  - the foldable settings panel: folded by default on a phone, expands, fits the
 *    viewport, remembers the choice across reloads;
 *  - one-finger pan, two-finger pinch zoom, two-finger twist rotation with the
 *    45° compass snap;
 *  - tap-to-select opens the building card with real OSM data;
 *  - 320 px width layout has no horizontal overflow;
 *  - desktop still starts with the panel expanded (regression).
 *
 * Emulated touch is NOT a real-phone performance claim; that limitation is
 * documented in docs/LIMITATIONS.md.
 */

import { test, expect, type Page } from '@playwright/test';
import type { CameraSettings, CityAppHandle, EngineStats } from '../../src/shared/appApi';
import { canvasClip, canvasScreenshot, imageDiffRatio } from './support/canvas';
import {
  delay,
  touchDrag,
  touchPinchOrTwist,
  type TouchPoint,
} from './support/touch';

declare global {
  interface Window {
    __CITY_APP__?: { ready?: boolean; app?: CityAppHandle; stats?: EngineStats };
    __CITY_STATS__?: EngineStats;
  }
}

const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const READY_TIMEOUT_MS = 60_000;
const IMAGE_DIFF_THRESHOLD = 0.01;
const BENIGN_CONSOLE_ERRORS = [
  /favicon\.ico/i,
  /Failed to load resource: the server responded with a status of 404 \(Not Found\)/,
];

test.use({
  viewport: MOBILE_VIEWPORT,
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});

interface Diagnostics {
  consoleErrors: string[];
  pageErrors: string[];
}

function watchPage(page: Page): Diagnostics {
  const diagnostics: Diagnostics = { consoleErrors: [], pageErrors: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.stack || String(error));
  });
  return diagnostics;
}

function expectClean(diagnostics: Diagnostics): void {
  const unexpected = diagnostics.consoleErrors.filter(
    (text) => !BENIGN_CONSOLE_ERRORS.some((pattern) => pattern.test(text)),
  );
  const detail = JSON.stringify(diagnostics, null, 2);
  expect(unexpected, `unexpected console errors:\n${detail}`).toEqual([]);
  expect(diagnostics.pageErrors, `uncaught page errors:\n${detail}`).toEqual([]);
}

async function waitForCityReady(page: Page): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => ({
        ready: window.__CITY_APP__?.ready === true,
        error:
          document.querySelector('[data-testid="error-message"]')?.textContent?.trim() ?? '',
      }))
      .catch(() => ({ ready: false, error: '' }));
    if (state.error) throw new Error(`Renderer reported a fatal error: ${state.error}`);
    if (state.ready) {
      ready = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  if (!ready) throw new Error(`City app did not report ready within ${READY_TIMEOUT_MS / 1000}s`);
  await expect
    .poll(
      () =>
        page
          .locator('[data-testid="loading-overlay"]')
          .evaluate((element) => element.classList.contains('hidden'))
          .catch(() => false),
      { timeout: 20_000, message: 'loading overlay should hide after ready' },
    )
    .toBe(true);
}

/** Small settle delay so the canvas is freshly presented before screenshots. */
async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)));
      }),
  );
  await page.waitForTimeout(ms);
}

async function openApp(page: Page): Promise<Diagnostics> {
  const diagnostics = watchPage(page);
  await page.goto('/');
  await waitForCityReady(page);
  await settle(page, 500);
  return diagnostics;
}

async function readCamera(page: Page): Promise<CameraSettings> {
  return page.evaluate(() => {
    const app = window.__CITY_APP__?.app;
    if (!app) throw new Error('window.__CITY_APP__.app is not exposed by the renderer');
    return app.getCameraSettings();
  });
}

function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** Subset of the engine's QA debug surface used to aim the tap test. */
interface CityDebugApi {
  datasetInfo(): {
    defaultView: { orthoHeight: number; targetLocalX: number; targetLocalY: number };
  };
  archetypeSamples(
    archetype: string,
    limit?: number,
  ): Array<{ id: string; localX: number; localY: number; height: number }>;
}

type DebugWindow = Window & { __CITY_DEBUG__?: CityDebugApi };

/**
 * Nearest loaded building to the default view centre, taken from the engine's
 * real streamed features: tapping blind is flaky, aiming at a known footprint
 * is not. The engine already has the complete-city tiles resident, so this
 * needs no test-side download of the 437-tile payload.
 */
async function findClickableBuilding(page: Page): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + 60_000;
  let lastError = 'the engine did not expose any loaded building';
  while (Date.now() < deadline) {
    const target = await page.evaluate(() => {
      const debug = (window as DebugWindow).__CITY_DEBUG__;
      if (!debug) return { error: 'window.__CITY_DEBUG__ is not exposed by the engine' };
      const info = debug.datasetInfo();
      const centreX = info.defaultView.targetLocalX;
      const centreY = info.defaultView.targetLocalY;
      const priority = ['khrushchev', 'panel', 'stalin', 'historic', 'office', 'modern', 'small'];
      for (const archetype of priority) {
        const samples = debug.archetypeSamples(archetype, 240);
        let best: { x: number; y: number; distance: number } | null = null;
        for (const sample of samples) {
          if (!(sample.height >= 8 && sample.height <= 60)) continue;
          const distance = Math.hypot(sample.localX - centreX, sample.localY - centreY);
          if (!best || distance < best.distance) {
            best = { x: sample.localX, y: sample.localY, distance };
          }
        }
        if (best) return best;
      }
      return { error: 'no loaded mid-rise building in the engine archetype samples yet' };
    });
    if (!('error' in target)) return { x: target.x, y: target.y };
    lastError = String(target.error);
    await page.waitForTimeout(500);
  }
  throw new Error(`Cannot locate a building in the loaded complete-city data: ${lastError}`);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('1. mobile HUD: settings panel is folded by default, toggles, persists, rotates', async ({
  page,
}) => {
  const diagnostics = await openApp(page);
  const panel = page.getByTestId('control-panel');
  const toggle = page.getByTestId('control-panel-toggle');
  const body = page.getByTestId('control-panel-body');

  // Folded by default on a phone.
  await expect(panel).toHaveAttribute('data-collapsed', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // Folded means small: it must not eat the screen.
  const collapsedBox = await panel.boundingBox();
  if (!collapsedBox) throw new Error('control panel has no bounding box');
  expect(collapsedBox.width, 'folded panel width').toBeLessThan(220);
  expect(collapsedBox.height, 'folded panel height').toBeLessThan(80);

  // The folded body is not visible (controls are not reachable).
  await expect(body).toBeHidden();

  // Expanding reveals the controls and fits the viewport.
  await toggle.tap();
  await expect(panel).toHaveAttribute('data-collapsed', 'false');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('rotate-right')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('minsk.hud.controlsCollapsed'))).toBe('0');

  const expandedBox = await panel.boundingBox();
  if (!expandedBox) throw new Error('expanded control panel has no bounding box');
  expect(expandedBox.x, 'panel left edge').toBeGreaterThanOrEqual(0);
  expect(expandedBox.x + expandedBox.width, 'panel right edge').toBeLessThanOrEqual(
    MOBILE_VIEWPORT.width + 1,
  );
  expect(expandedBox.height, 'panel height').toBeLessThanOrEqual(MOBILE_VIEWPORT.height);

  // The rotate buttons step the azimuth by exactly 45°.
  const before = await readCamera(page);
  await page.getByTestId('rotate-right').tap();
  await settle(page, 300);
  const afterRight = await readCamera(page);
  expect(angleDelta(before.azimuth, afterRight.azimuth)).toBeCloseTo(Math.PI / 4, 3);

  await page.getByTestId('rotate-left').tap();
  await settle(page, 300);
  const afterLeft = await readCamera(page);
  expect(angleDelta(afterRight.azimuth, afterLeft.azimuth)).toBeCloseTo(-Math.PI / 4, 3);

  // Persistence: an expanded choice survives a reload …
  await page.reload();
  await waitForCityReady(page);
  await expect(panel).toHaveAttribute('data-collapsed', 'false');

  // … and so does a folded one.
  await toggle.tap();
  await expect(panel).toHaveAttribute('data-collapsed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('minsk.hud.controlsCollapsed'))).toBe('1');
  await page.reload();
  await waitForCityReady(page);
  await expect(panel).toHaveAttribute('data-collapsed', 'true');

  expectClean(diagnostics);
});

test('2. mobile: one-finger drag pans the map and does not select a building', async ({
  page,
  context,
}) => {
  const diagnostics = await openApp(page);
  const cdp = await context.newCDPSession(page);
  const box = await canvasClip(page);

  const before = await canvasScreenshot(page);
  const start: TouchPoint = { id: 11, x: box.x + box.width * 0.3, y: box.y + box.height * 0.7 };
  const end: TouchPoint = { id: 11, x: start.x + 80, y: start.y - 40 };
  await touchDrag(cdp, start, end);
  await settle(page, 700);
  const after = await canvasScreenshot(page);

  const diff = await imageDiffRatio(page, before, after);
  expect(diff.ratio, 'a one-finger drag must visibly pan the map').toBeGreaterThan(
    IMAGE_DIFF_THRESHOLD,
  );
  await expect(page.getByTestId('info-panel')).toHaveCount(0);

  expectClean(diagnostics);
});

test('3. mobile: two-finger pinch zooms in and does not select a building', async ({
  page,
  context,
}) => {
  const diagnostics = await openApp(page);
  const cdp = await context.newCDPSession(page);
  const box = await canvasClip(page);
  const before = await readCamera(page);

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.6;
  const first: TouchPoint = { id: 21, x: cx - 55, y: cy };
  const second: TouchPoint = { id: 22, x: cx + 55, y: cy };
  const spread = (amount: number): [TouchPoint, TouchPoint] => [
    { ...first, x: cx - amount },
    { ...second, x: cx + amount },
  ];
  await touchPinchOrTwist(cdp, [first, second], [spread(75), spread(105), spread(135)]);
  await settle(page, 800);

  const after = await readCamera(page);
  expect(after.orthoHeight, 'pinching out must zoom in').toBeLessThan(before.orthoHeight * 0.8);
  await expect(page.getByTestId('info-panel')).toHaveCount(0);

  expectClean(diagnostics);
});

test('4. mobile: two-finger twist rotates and snaps to the 45° compass', async ({
  page,
  context,
}) => {
  const diagnostics = await openApp(page);
  const cdp = await context.newCDPSession(page);
  const box = await canvasClip(page);
  const before = await readCamera(page);

  const midX = box.x + box.width / 2;
  const midY = box.y + box.height * 0.6;
  const radius = 60;
  const pairAt = (angle: number): [TouchPoint, TouchPoint] => [
    { id: 31, x: midX - radius * Math.cos(angle), y: midY - radius * Math.sin(angle) },
    { id: 32, x: midX + radius * Math.cos(angle), y: midY + radius * Math.sin(angle) },
  ];
  await touchPinchOrTwist(cdp, pairAt(0), [pairAt(0.15), pairAt(0.45), pairAt(0.9)]);
  await settle(page, 800);

  const after = await readCamera(page);
  const delta = angleDelta(before.azimuth, after.azimuth);
  expect(Math.abs(delta), 'twist must change the azimuth').toBeGreaterThan(0.2);

  const step = Math.PI / 4;
  const remainder = Math.abs(after.azimuth / step - Math.round(after.azimuth / step));
  expect(remainder, `azimuth ${after.azimuth} should snap to a 45° multiple`).toBeLessThan(0.02);
  await expect(page.getByTestId('info-panel')).toHaveCount(0);

  expectClean(diagnostics);
});

test('5. mobile: tap selects a building and opens the info panel', async ({ page }) => {
  const diagnostics = await openApp(page);
  const target = await findClickableBuilding(page);
  await page.evaluate(
    ({ x, y }) => {
      const app = window.__CITY_APP__?.app;
      if (!app) throw new Error('app handle is missing');
      app.focusOnLocal(x, y);
      app.setCameraSettings({ orthoHeight: 110 });
    },
    target,
  );
  await settle(page, 900);

  const box = await canvasClip(page);
  const infoPanel = page.getByTestId('info-panel');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  let visible = await infoPanel.isVisible({ timeout: 3_000 }).catch(() => false);

  // Fallback: scan a small grid over the map (HUD panels sit at the edges).
  if (!visible) {
    const fractions = [0.5, 0.45, 0.55, 0.4, 0.6];
    scan: for (const fx of fractions) {
      for (const fy of fractions) {
        await page.touchscreen.tap(box.x + box.width * fx, box.y + box.height * fy);
        visible = await infoPanel.isVisible({ timeout: 800 }).catch(() => false);
        if (visible) break scan;
        // Stay outside the double-tap window between blind taps.
        await delay(400);
      }
    }
  }

  expect(visible, 'tapping a building should open the info panel').toBe(true);

  const osmId = page.locator('[data-testid="info-osm-id"]').first();
  await expect(osmId).toBeVisible();
  expect((await osmId.textContent())?.trim() ?? '').toMatch(/^[wr]\d+$/);

  await page.locator('[data-testid="info-panel"] .close').first().tap();
  await expect(infoPanel).toBeHidden({ timeout: 5_000 });

  expectClean(diagnostics);
});

test('6. mobile: 320 px viewport has no horizontal overflow and keeps the panel on screen', async ({
  page,
}) => {
  const diagnostics = await openApp(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await settle(page, 500);

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth, 'no horizontal page scroll at 320 px').toBeLessThanOrEqual(
    overflow.innerWidth + 1,
  );

  const panel = page.getByTestId('control-panel');
  const toggle = page.getByTestId('control-panel-toggle');
  await expect(panel).toHaveAttribute('data-collapsed', 'true');
  await toggle.tap();
  await expect(panel).toHaveAttribute('data-collapsed', 'false');

  const box = await panel.boundingBox();
  if (!box) throw new Error('control panel has no bounding box');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'panel right edge at 320 px').toBeLessThanOrEqual(321);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, 'panel bottom edge at 320 px').toBeLessThanOrEqual(569);

  expectClean(diagnostics);
});

test.describe('desktop HUD regression', () => {
  test.use({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
  });

  test('7. desktop: settings panel starts expanded and folds on demand', async ({ page }) => {
    const diagnostics = await openApp(page);
    const panel = page.getByTestId('control-panel');
    const toggle = page.getByTestId('control-panel-toggle');
    const body = page.getByTestId('control-panel-body');

    await expect(panel).toHaveAttribute('data-collapsed', 'false');
    await expect(body).toBeVisible();
    await expect(page.getByTestId('rotate-right')).toBeVisible();

    await toggle.click();
    await expect(panel).toHaveAttribute('data-collapsed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('minsk.hud.controlsCollapsed'))).toBe('1');

    await page.reload();
    await waitForCityReady(page);
    await expect(panel).toHaveAttribute('data-collapsed', 'true');

    expectClean(diagnostics);
  });
});
