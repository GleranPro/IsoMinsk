/**
 * Reference screenshot for aligning the user's annotated product view.
 *
 * Camera is fixed per run (env REF_AZ / REF_ORTHO / REF_NAME) and the HUD is
 * hidden, so the projection is a known linear map. Metadata is written next to
 * the PNG for the alignment script.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const OUT = path.resolve('screenshots/museum');
fs.mkdirSync(OUT, { recursive: true });

const ORTHO = Number(process.env.REF_ORTHO ?? 200);
const AZIMUTH = Number(process.env.REF_AZ ?? 0);
const NAME = process.env.REF_NAME ?? 'ref-north';
const PIXEL = process.env.REF_PIXEL === '1';
const CENTER = { x: 9300, y: 655 };
const WIDTH = 1280;
const HEIGHT = 800;
const ELEVATION = Math.atan(1 / Math.SQRT2);

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'],
  headless: true,
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
page.setDefaultTimeout(180_000);
await page.goto(`${BASE}/?dataset=city&focus=lipki`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 180_000 });
await page.waitForFunction(() => window.__CITY_DEBUG__?.museum?.().state === 'ready', null, { timeout: 180_000 });
await page.evaluate(({ ortho, cx, cy, az, pixel }) => {
  document.querySelectorAll('.hud').forEach((element) => {
    element.style.display = 'none';
  });
  const app = window.__CITY_APP__.app;
  app.setPixelEffectEnabled(pixel);
  app.setCameraSettings({ azimuth: az, orthoHeight: ortho });
  app.focusOnLocal(cx, cy);
}, { ortho: ORTHO, cx: CENTER.x, cy: CENTER.y, az: AZIMUTH, pixel: PIXEL });
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(OUT, `${NAME}.png`), timeout: 180_000 });

const meta = {
  width: WIDTH,
  height: HEIGHT,
  orthoHeight: ORTHO,
  azimuth: AZIMUTH,
  elevation: ELEVATION,
  sinElevation: Math.sin(ELEVATION),
  center: CENTER,
  pxPerMetre: HEIGHT / 2 / ORTHO,
};
fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify(meta, null, 1));
console.log('wrote', `${NAME}.png`, meta);
await browser.close();
