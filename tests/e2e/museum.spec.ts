import { test, expect } from '@playwright/test';
import type * as THREE from 'three';
import type { CityAppHandle, EngineStats } from '../../src/shared/appApi';

/**
 * Lipki aviation museum (product integration).
 *
 * The exhibits live at x ≈ 9.3 km east of the pilot centre, i.e. only inside the
 * `?dataset=city` extent. `?focus=lipki` frames them on start-up; the control
 * panel button uses the same engine API.
 */

interface MuseumMeshLike {
  isMesh?: boolean;
  geometry?: { attributes?: { position?: { count: number }; color?: unknown } };
  castShadow?: boolean;
}

declare global {
  interface Window {
    __CITY_APP__?: { ready?: boolean; app?: CityAppHandle; stats?: EngineStats };
    __CITY_STATS__?: EngineStats;
    __CITY_DEBUG__?: {
      museum(): {
        state: string;
        triangles: number;
        exhibits: number;
        missing: number;
        error: string | null;
      };
      museumObject(): {
        root: THREE.Object3D & { visible: boolean; position: THREE.Vector3 };
        getWorldBounds(): THREE.Box3;
      };
    };
  }
}

test('Lipki museum exhibits render in the city dataset', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/.test(message.text())) errors.push(message.text());
  });

  await page.goto('/?dataset=city&focus=lipki');
  await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const info = window.__CITY_DEBUG__?.museum();
      return info !== undefined && (info.state === 'ready' || info.state === 'error');
    },
    null,
    { timeout: 90000 },
  );

  const museum = await page.evaluate(() => {
    const info = window.__CITY_DEBUG__!.museum();
    const layer = window.__CITY_DEBUG__!.museumObject();
    let found: MuseumMeshLike | null = null;
    layer.root.traverse((child) => {
      const candidate = child as unknown as MuseumMeshLike;
      if (!found && candidate.isMesh) found = candidate;
    });
    const mesh = found as MuseumMeshLike | null;
    const box = layer.getWorldBounds();
    return {
      ...info,
      level: layer.root.children.length,
      visible: layer.root.visible,
      position: [layer.root.position.x, layer.root.position.y, layer.root.position.z],
      world: { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z },
      vertices: mesh?.geometry?.attributes?.position?.count ?? 0,
      hasColors: Boolean(mesh?.geometry?.attributes?.color),
      castShadow: Boolean(mesh?.castShadow),
    };
  });

  expect(museum.state).toBe('ready');
  expect(museum.exhibits).toBe(30);
  expect(museum.missing).toBe(9);
  expect(museum.triangles).toBeGreaterThan(50000);
  expect(museum.vertices).toBe(museum.triangles * 3);
  expect(museum.hasColors).toBe(true);
  expect(museum.visible).toBe(true);
  expect(museum.castShadow).toBe(true);
  expect(museum.position[0]).toBeCloseTo(9300, 0);
  expect(museum.position[2]).toBeCloseTo(-650, 0);
  expect(museum.world.maxX - museum.world.minX).toBeGreaterThan(100);
  expect(museum.world.maxZ - museum.world.minZ).toBeGreaterThan(200);

  // The control-panel button calls this handle method; it must keep the layer
  // resident and leave the camera framed on the exhibits.
  await page.evaluate(() => window.__CITY_APP__!.app!.focusMuseum());
  await page.waitForTimeout(1200);
  const stats = await page.evaluate(() => window.__CITY_APP__!.app!.getStats());
  expect(stats.loadedTiles).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__CITY_DEBUG__!.museum().state)).toBe('ready');

  await page.screenshot({ path: 'test-results/museum-lipki.png', timeout: 90000 });
  expect(errors).toEqual([]);
});

test('museum control switches the central dataset to the city deep link', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 90000 });
  await expect(page.locator('[data-testid="focus-museum"]')).toBeEnabled();
  await Promise.all([
    page.waitForURL(/dataset=city/, { timeout: 90000 }),
    page.click('[data-testid="focus-museum"]'),
  ]);
  const url = new URL(page.url());
  expect(url.searchParams.get('dataset')).toBe('city');
  expect(url.searchParams.get('focus')).toBe('lipki');
});
