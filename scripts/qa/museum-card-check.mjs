/**
 * Click an exhibit in the running app and verify the museum card opens.
 * Usage: node scripts/qa/museum-card-check.mjs [baseUrl]
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const OUT = path.resolve('screenshots/museum');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'],
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(180_000);
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error' && !/favicon|404/.test(message.text())) errors.push(message.text());
});

await page.goto(`${BASE}/?dataset=city&focus=lipki`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 180_000 });
await page.waitForFunction(() => window.__CITY_DEBUG__?.museum?.().state === 'ready', null, { timeout: 180_000 });
await page.waitForTimeout(3000);

const target = await page.evaluate(() => {
  const debug = window.__CITY_DEBUG__;
  const layer = debug.museumObject();
  const THREE = debug.three();
  const app = window.__CITY_APP__.app;
  app.setCameraSettings({ azimuth: Math.PI / 4, orthoHeight: 110 });
  const exhibits = layer.manifest.exhibits;
  // pick a large, isolated exhibit: the Mi-26
  const index = exhibits.findIndex((exhibit) => exhibit.slug === 'mi-26');
  app.focusOnLocal(exhibits[index].x, exhibits[index].y);
  const canvas = document.querySelector('canvas');
  return { index, slug: exhibits[index].slug, ref: exhibits[index].ref };
});
await page.waitForTimeout(4000);

const click = await page.evaluate(({ index }) => {
  const debug = window.__CITY_DEBUG__;
  const layer = debug.museumObject();
  const THREE = debug.three();
  const exhibit = layer.manifest.exhibits[index];
  const camera = debug.cameraObject();
  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const point = new THREE.Vector3(exhibit.x, 3, -exhibit.y).project(camera);
  return {
    x: rect.left + (point.x * 0.5 + 0.5) * rect.width,
    y: rect.top + (-point.y * 0.5 + 0.5) * rect.height,
    world: { x: exhibit.x, y: exhibit.y },
  };
}, target);
console.log('target', target, 'click at', click);

await page.mouse.click(click.x, click.y);
await page.waitForSelector('[data-testid="museum-card"]', { timeout: 30_000 });
const card = await page.evaluate(() => {
  const element = document.querySelector('[data-testid="museum-card"]');
  const canvas = element?.querySelector('canvas');
  return {
    title: element?.querySelector('h2')?.textContent ?? null,
    subtitle: element?.querySelector('.museum-subtitle')?.textContent ?? null,
    description: element?.querySelector('.museum-description')?.textContent?.slice(0, 80) ?? null,
    links: Array.from(element?.querySelectorAll('.museum-links a') ?? []).map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
    })),
    preview: canvas ? { width: canvas.width, height: canvas.height } : null,
  };
});
console.log(JSON.stringify(card, null, 1));
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(OUT, '04-exhibit-card.png'), timeout: 180_000 });

fs.writeFileSync(path.join(OUT, 'card-check.json'), JSON.stringify({ target, click, card, errors }, null, 1));
console.log('errors', errors);
await browser.close();
