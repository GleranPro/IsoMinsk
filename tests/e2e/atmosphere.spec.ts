/**
 * Atmosphere (liveness) controls e2e.
 *
 * Rules of the suite (see city.spec.ts header) apply: never weak-assert, no
 * retries, everything through window.__CITY_APP__ / __CITY_DEBUG__. This spec
 * only asserts control plumbing and honest state — no frame-time or
 * clock-timing assertions (software WebGL is far too slow for those; the
 * perf budget lives in `scripts/qa/liveness-perf.mjs`).
 */

import { expect, test, type Page } from '@playwright/test';
import type { CityAppHandle } from '../../src/shared/appApi';

async function openApp(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, {
    timeout: 120_000,
  });
}

async function callApp<T>(
  page: Page,
  method: keyof CityAppHandle,
): Promise<T> {
  return page.evaluate(
    (name) => {
      const app = window.__CITY_APP__?.app;
      const fn = app ? (app as unknown as Record<string, () => unknown>)[name] : undefined;
      return (fn ? fn() : null) as T;
    },
    method as string,
  );
}

test.describe('Isometric Minsk — atmosphere', () => {
  test('lighting clock follows real Minsk time and manual pins work', async ({ page }) => {
    await openApp(page);

    const info = await callApp<{ hours: number; mode: string }>(page, 'getTimeOfDayInfo');
    expect(info.mode).toBe('auto');
    expect(info.hours).toBeGreaterThanOrEqual(0);
    expect(info.hours).toBeLessThan(24);

    await page.evaluate(() => window.__CITY_APP__?.app?.setTimeOfDay(21.5));
    const pinned = await callApp<{ hours: number; mode: string }>(page, 'getTimeOfDayInfo');
    expect(pinned.mode).toBe('manual');
    expect(pinned.hours).toBeCloseTo(21.5, 1);

    await page.evaluate(() => window.__CITY_APP__?.app?.setTimeMode('auto'));
    const restored = await callApp<{ mode: string }>(page, 'getTimeOfDayInfo');
    expect(restored.mode).toBe('auto');
  });

  test('atmosphere toggles report honest state', async ({ page }) => {
    await openApp(page);

    await page.evaluate(() => window.__CITY_APP__?.app?.setCloudsEnabled(false));
    expect(await callApp<boolean>(page, 'getCloudsEnabled')).toBe(false);
    await page.evaluate(() => window.__CITY_APP__?.app?.setCloudsEnabled(true));
    expect(await callApp<boolean>(page, 'getCloudsEnabled')).toBe(true);

    await page.evaluate(() => window.__CITY_APP__?.app?.setWeather('snow', 0.5));
    const weather = await callApp<{ kind: string; amount: number }>(page, 'getWeather');
    expect(weather.kind).toBe('snow');
    expect(weather.amount).toBeCloseTo(0.5, 2);

    await page.evaluate(() => window.__CITY_APP__?.app?.setSeason('winter'));
    expect(await callApp<string>(page, 'getSeason')).toBe('winter');
    await page.evaluate(() => window.__CITY_APP__?.app?.setSeason('auto'));
    expect(await callApp<string>(page, 'getSeason')).toBe('auto');
  });

  test('stats expose the atmosphere section', async ({ page }) => {
    await openApp(page);
    await expect
      .poll(async () => {
        const stats = await page.evaluate(() => window.__CITY_STATS__ ?? null);
        return stats?.atmosphere ?? null;
      })
      .not.toBeNull();
    const atmosphere = await page.evaluate(() => window.__CITY_STATS__?.atmosphere ?? null);
    expect(atmosphere).not.toBeNull();
    expect(['auto', 'manual']).toContain(atmosphere!.timeMode);
    expect(['spring', 'summer', 'autumn', 'winter']).toContain(atmosphere!.season);
    expect(['off', 'rain', 'snow']).toContain(atmosphere!.weather);
    expect(atmosphere!.clouds).toBeGreaterThanOrEqual(0);
    expect(atmosphere!.lamps).toBeGreaterThanOrEqual(0);
  });

  test('atmosphere debug accessor reflects a pinned winter night', async ({ page }) => {
    await page.goto('/?time=23&season=winter&weather=snow', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, {
      timeout: 120_000,
    });
    // The debug surface is typed narrowly in museum.spec.ts; this spec reads
    // the atmosphere subset through a local cast (same pattern as city.spec).
    type DebugApi = { atmosphere?: () => Record<string, unknown>; lamps?: () => Record<string, unknown> };
    const readDebug = () =>
      page.evaluate(() => {
        const api = (window as unknown as { __CITY_DEBUG__?: DebugApi }).__CITY_DEBUG__;
        return {
          atmosphere: api?.atmosphere?.() ?? null,
          lamps: api?.lamps?.() ?? null,
        };
      });
    await expect
      .poll(async () => (await readDebug()).atmosphere)
      .not.toBeNull();
    const debug = await readDebug();
    expect(debug.atmosphere!.timeMode).toBe('manual');
    expect(debug.atmosphere!.season).toBe('winter');
    expect((debug.atmosphere!.weather as { kind: string }).kind).toBe('snow');
    expect(debug.atmosphere!.snow as number).toBeGreaterThan(0.5);
    expect(debug.lamps!.enabled).toBe(true);
  });
});
