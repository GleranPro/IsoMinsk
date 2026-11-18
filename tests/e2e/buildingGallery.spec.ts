/**
 * L1 building-family gallery browser checks.
 *
 * The gallery is a QA entry (not a public map mode): it renders one fixture per
 * recipe with the production geometry builder and facade material. These tests
 * assert the panels actually render, that the debug API exposes the checklist
 * data, and that no shader/console errors occur.
 */

import { expect, test } from '@playwright/test';

const GALLERY_URL = '/qa/building-gallery.html';

test.describe('building family gallery', () => {
  test('renders all 27 recipe panels without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.goto(GALLERY_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__BUILDING_GALLERY__?.ready === true, null, {
      timeout: 120_000,
    });

    const summary = await page.evaluate(() => {
      const gallery = window.__BUILDING_GALLERY__!;
      return {
        ready: gallery.ready,
        readyPanels: gallery.readyPanels,
        expectedPanels: gallery.expectedPanels,
        panels: gallery.panels,
      };
    });

    expect(summary.expectedPanels).toBe(27);
    expect(summary.readyPanels).toBe(27);
    expect(summary.panels.map((panel) => panel.recipeId)).toEqual(
      Array.from({ length: 27 }, (_, id) => id),
    );
    for (const panel of summary.panels) {
      expect(panel.triangles, `panel ${panel.recipeId} triangles`).toBeGreaterThan(0);
      expect(panel.wallTriangles, `panel ${panel.recipeId} wall triangles`).toBeGreaterThanOrEqual(2);
      expect(panel.roofTriangles, `panel ${panel.recipeId} roof triangles`).toBeGreaterThanOrEqual(1);
      expect(panel.bytes, `panel ${panel.recipeId} bytes`).toBeGreaterThan(0);
    }
    expect(errors).toEqual([]);
  });

  test('the panel camera actually draws geometry in day and night light', async ({ page }) => {
    await page.goto(GALLERY_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__BUILDING_GALLERY__?.ready === true, null, {
      timeout: 120_000,
    });

    const sample = await page.evaluate(() => {
      const gallery = window.__BUILDING_GALLERY__!;
      const elevation = Math.atan(1 / Math.SQRT2);
      gallery.setCamera({ panel: 6, orthoHeight: 90, azimuth: Math.PI / 4, elevation, timeHours: 13 });
      const day = gallery.canvasStats();
      gallery.setCamera({ panel: 6, timeHours: 22 });
      const night = gallery.canvasStats();
      gallery.setCamera({ panel: 6, timeHours: 13, order: 'seeded' });
      const seeded = gallery.canvasStats();
      return { day, night, seeded };
    });

    for (const [label, stats] of Object.entries(sample)) {
      expect(stats.sampledPixels, label).toBeGreaterThan(0);
      expect(stats.coveredPixels / stats.sampledPixels, `${label} coverage`).toBeGreaterThan(0.02);
    }
    expect(sample.day.meanLuma).toBeGreaterThan(8);
  });

  test('gallery fixture heights and roofs match the declared recipe eligibility', async ({ page }) => {
    await page.goto(GALLERY_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__BUILDING_GALLERY__?.ready === true, null, {
      timeout: 120_000,
    });
    const panels = await page.evaluate(() => window.__BUILDING_GALLERY__!.panels);
    const byId = new Map(panels.map((panel) => [panel.recipeId, panel]));
    // Mansard attic is a low-rise historic envelope; the sawtooth hall is tall.
    expect(byId.get(17)!.height).toBeLessThanOrEqual(14);
    expect(byId.get(17)!.sourceRoof).toBe('flat');
    expect(byId.get(18)!.height).toBeGreaterThanOrEqual(6);
    expect(byId.get(18)!.sourceRoof).toBe('flat');
    expect(byId.get(26)!.name).toBe('assembly_hall');
    // Every panel carries the geometry-mode label data the capture script records.
    for (const panel of panels) {
      expect(panel.profile.length).toBeGreaterThan(0);
      expect(panel.facade.length).toBeGreaterThan(0);
      expect(panel.roof.length).toBeGreaterThan(0);
    }
  });
});
