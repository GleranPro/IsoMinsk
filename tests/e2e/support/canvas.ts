/**
 * Shared canvas screenshot + image-diff helpers for Playwright specs.
 *
 * The PNG is decoded inside the browser (2D canvas), so the test suite needs no
 * image dependency. A change is only counted when any RGB channel moves by more
 * than 18, which ignores antialiasing/compression noise.
 */

import { expect, type Page } from '@playwright/test';

export interface CanvasClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageDiff {
  ratio: number;
  differingPixels: number;
  sampledPixels: number;
}

/** Visible canvas rectangle in CSS pixels (fails loudly when absent/tiny). */
export async function canvasClip(page: Page): Promise<CanvasClip> {
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

/** Screenshot of the canvas element only (HUD panels excluded). */
export async function canvasScreenshot(page: Page): Promise<Buffer> {
  const clip = await canvasClip(page);
  return page.screenshot({ clip, timeout: 60_000 });
}

/** Fraction of sampled pixels that differ noticeably between two PNG buffers. */
export async function imageDiffRatio(
  page: Page,
  before: Buffer,
  after: Buffer,
): Promise<ImageDiff> {
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
