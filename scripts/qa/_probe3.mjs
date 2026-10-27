// Temporary QA readiness probe for the current build (deleted after use).
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const args = process.env.QA_GPU === '1'
  ? ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu']
  : ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--disable-gpu-sandbox'];

const browser = await chromium.launch({ headless: true, args });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
let last = null;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  last = await page.evaluate(() => {
    const api = window.__CITY_APP__;
    return {
      ready: api?.ready ?? null,
      stats: window.__CITY_STATS__ ?? api?.stats ?? null,
      overlay: document.querySelector('[data-testid="loading-overlay"]')?.className ?? null,
    };
  }).catch((error) => ({ probeError: String(error) }));
  if (last?.ready === true) break;
  await page.waitForTimeout(400);
}
await page.waitForTimeout(3_000);
last = await page.evaluate(() => {
  const api = window.__CITY_APP__;
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
  return {
    ready: api?.ready ?? null,
    stats: window.__CITY_STATS__ ?? api?.stats ?? null,
    overlay: document.querySelector('[data-testid="loading-overlay"]')?.className ?? null,
    hud: {
      fps: text('[data-testid="stat-fps"]'),
      triangles: text('[data-testid="stat-triangles"]'),
      tiles: text('[data-testid="stat-tiles"]'),
      buildings: text('[data-testid="stat-buildings"]'),
    },
    camera: api?.app?.getCameraSettings?.() ?? null,
  };
});
await mkdir('test-results', { recursive: true });
await page.screenshot({ path: 'test-results/final-probe.png' });
console.log(JSON.stringify({ ...last, errors: errors.slice(0, 5) }, null, 2));
await browser.close();
