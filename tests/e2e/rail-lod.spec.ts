import { test, expect } from '@playwright/test';

test('ground and bridge railheads retain colour and coverage across LOD tiers', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const rasterModule = '/src/city/ground/groundRaster.ts';
    const decksModule = '/src/city/ground/groundDecks.ts';
    const { rasterizeGround, paintRailHeads } = await import(/* @vite-ignore */ rasterModule);
    const { rasterizeDecks } = await import(/* @vite-ignore */ decksModule);
    const tile = {
      tileX: 0, tileY: 0, bounds: [0, 0, 256, 256], buildings: [], roads: [], trees: [], surfaces: [],
      ground: { version: 2, strokes: [
        { k: 'rail', c: 'unknown', w: 3.5, p: [16, 64, 240, 64], s0: 0, r: 0 },
      ] },
    };
    const means = [0.25, 0.5, 1, 2, 4].map(res => {
      const raster = rasterizeGround(tile, tile.bounds, res);
      const rgb = [0, 0, 0];
      let count = 0;
      for (let y = (256 - 72) / res; y < (256 - 56) / res; y++) {
        for (let x = 24 / res; x < 232 / res; x++) {
          const i = (y * raster.width + x) * 4;
          for (let c = 0; c < 3; c++) rgb[c] += raster.data[i + c];
          count++;
        }
      }
      return rgb.map(c => c / count);
    });
    // A service road provides the same opaque underlay on ground and deck,
    // including coarse texels; no lane paint can obscure the heads.
    const parity: boolean[] = [];
    const coverage: number[] = [];
    for (const kind of ['rail', 'tram']) {
      tile.ground.strokes[0].k = kind;
      for (const res of [0.5, 1, 4]) {
        const underlay = { k: 'road', c: 'service', w: 16, p: [0, 64, 256, 64], s0: 0, r: 0 };
        const strokes = [underlay, ...tile.ground.strokes];
        const ground = rasterizeGround({ ...tile, ground: { ...tile.ground, strokes } }, tile.bounds, res);
        const deck = { bb: tile.bounds, s: strokes, f: [], dv: [],
          r: [{ p: [0, 0, 256, 0, 256, 256, 0, 256] }], t: [] };
        const atlas = rasterizeDecks([deck], res);
        const rect = atlas.rects[0];
        let same = true;
        for (let y = (256 - 68) / res; y < (256 - 60) / res; y++) {
          for (let x = 24 / res; x < 232 / res; x++) {
            const ax = rect.ax + (x * res - rect.x0) / res;
            const ay = rect.ay + (rect.y1 - 256 + y * res) / res;
            const gi = (y * ground.width + x) * 4;
            const ai = (ay * atlas.width + ax) * 4;
            for (let c = 0; c < 4; c++) if (ground.data[gi + c] !== atlas.data[ai + c]) same = false;
          }
        }
        parity.push(same);
        const canvas = new OffscreenCanvas(256 / res, 256 / res);
        const ctx = canvas.getContext('2d')!;
        paintRailHeads(ctx, tile, tile.bounds, res);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let area = 0;
        for (let i = 3; i < data.length; i += 4) area += data[i] / 255 * res * res;
        // Two 224 m heads, 15 cm wide; a whole-texel line violates this by
        // up to 26×. Allow Skia's integer coverage rounding on subtexel lines.
        coverage.push(area);
      }
    }
    return { means, parity, coverage };
  });
  for (let c = 0; c < 3; c++) {
    const values = result.means.map(rgb => rgb[c]);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(3.5);
  }
  expect(result.parity.every(Boolean)).toBe(true);
  for (const area of result.coverage) {
    expect(area).toBeGreaterThan(55);
    expect(area).toBeLessThan(80);
  }
});
