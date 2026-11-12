/**
 * Capture the Lipki museum inside the running app.
 *
 * Usage: node scripts/qa/museum-shots.mjs [baseUrl]
 * Assumes the Vite dev server is already running (pnpm dev).
 * Writes screenshots/museum/*.png and screenshots/museum/state.json.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const OUT = path.resolve('screenshots/museum');
fs.mkdirSync(OUT, { recursive: true });

const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
];

const browser = await chromium.launch({ args: SWIFTSHADER_ARGS, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(180_000);
const consoleLines = [];
page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`));

const url = `${BASE}/?dataset=city&focus=lipki`;
console.log('open', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });

await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 180_000 });
console.log('engine ready');
await page.waitForFunction(
  () => {
    const info = window.__CITY_DEBUG__?.museum?.();
    return info && (info.state === 'ready' || info.state === 'error');
  },
  null,
  { timeout: 180_000 },
);
const museum = await page.evaluate(() => window.__CITY_DEBUG__.museum());
console.log('museum', JSON.stringify(museum));

const shot = async (name) => {
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, name), timeout: 180_000 });
  console.log('shot', name);
};

await shot('01-lipki.png');

await page.evaluate(() => {
  const app = window.__CITY_APP__.app;
  app.setCameraSettings({ orthoHeight: 95 });
  app.focusOnLocal(9297, 660);
});
await shot('02-lipki-close.png');

await page.evaluate(() => {
  const app = window.__CITY_APP__.app;
  app.setCameraSettings({ azimuth: 0, orthoHeight: 130 });
  app.focusOnLocal(9297, 660);
});
await shot('03-lipki-north.png');

const stats = await page.evaluate(() => window.__CITY_STATS__ ?? null);
const state = {
  url,
  museum,
  stats,
  console: consoleLines.filter((line) => /museum|error|Error|warn/.test(line)).slice(0, 40),
};
fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify(state, null, 1));
fs.writeFileSync(path.join(OUT, 'console.log'), consoleLines.join('\n'));
console.log('wrote', OUT);

await browser.close();
