import { test, expect } from '@playwright/test';

test('instanced real-map trees survive appearance changes in workers and inline fallback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error' && !/favicon|404/.test(message.text())) errors.push(message.text()); });
  for (const fallback of [false, true]) {
    if (fallback) await page.addInitScript(() => { Object.defineProperty(window, 'Worker', { value: undefined, configurable: true }); });
    await page.goto('/?treeStyle=clustered&nolimit=1');
    await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 60000 });
    await page.waitForFunction(() => window.__CITY_APP__?.app?.getStats().loadedTiles === 16);
    const before = await page.evaluate(() => {
      const debug = (window as unknown as { __CITY_DEBUG__: any }).__CITY_DEBUG__;
      const root = debug.cityRootObject();
      const meshes: any[] = [];
      root.traverse((mesh: any) => { if (mesh.isInstancedMesh) meshes.push(mesh); });
      return { trees: debug.trees(), meshes: meshes.length,
        bounded: meshes.every(m => m.boundingSphere?.radius > 0 && Number.isFinite(m.boundingSphere.radius)),
        allInstanced: meshes.every(m => m.instanceMatrix.array.length === m.count * 16) };
    });
    expect(before.trees.style).toBe('clustered');
    expect(before.trees.count).toBeGreaterThan(0);
    expect(before.meshes).toBe(before.trees.batches);
    expect(before.bounded).toBe(true);
    expect(before.allInstanced).toBe(true);
    const appearance = await page.evaluate(() => {
      const debug = (window as unknown as { __CITY_DEBUG__: any }).__CITY_DEBUG__;
      const root = debug.cityRootObject();
      const crowns: any[] = [], trunks: any[] = [], attractions: any[] = [];
      root.traverse((m: any) => {
        if (m.name.includes('-crown-')) crowns.push(m);
        if (m.name.endsWith('-trunks')) trunks.push(m);
        if (m.name.startsWith('attractions-')) attractions.push(m);
      });
      const original = crowns.map(m => Array.from(m.instanceColor.array));
      const attributes = crowns.map(m => [m.instanceColor, m.instanceMatrix, m.geometry]);
      debug.setCanopyAppearance({ visible: false, palette: ['#c19142', '#a77b30', '#cbb353', '#9d6331'] });
      const hidden = crowns.every(m => !m.visible);
      const unaffected = [...trunks, ...attractions].every(m => m.visible);
      const recoloured = crowns.some((m, i) => JSON.stringify(Array.from(m.instanceColor.array)) !== JSON.stringify(original[i]));
      debug.setCanopyAppearance({ visible: true });
      return { hidden, unaffected, recoloured,
        restored: crowns.every(m => m.visible),
        unchangedStorage: crowns.every((m, i) => m.instanceColor === attributes[i][0] && m.instanceMatrix === attributes[i][1] && m.geometry === attributes[i][2]) };
    });
    expect(appearance).toEqual({ hidden: true, unaffected: true, recoloured: true, restored: true, unchangedStorage: true });
    await page.evaluate(() => {
      const app = window.__CITY_APP__!.app!;
      app.setCameraSettings({ azimuth: 2.35, orthoHeight: 100 });
      app.setTimeOfDay(21);
    });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__CITY_APP__!.app!.getStats().triangles)).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});
