/**
 * Capture the War Museum Li-2 inside the running app.
 *
 * Usage: node scripts/qa/li2-shots.mjs [baseUrl]
 * Assumes the Vite dev server is running (pnpm dev).
 * Writes screenshots/warmuseum/*.png and state.json.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const OUT = path.resolve('screenshots/warmuseum');
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

const url = `${BASE}/?dataset=city&focus=li2`;
console.log('open', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 180_000 });
console.log('engine ready');
await page.waitForFunction(
  () => {
    const info = window.__CITY_DEBUG__?.warMuseum?.();
    return info && (info.state === 'ready' || info.state === 'error');
  },
  null,
  { timeout: 180_000 },
);
const state = await page.evaluate(() => ({
  warMuseum: window.__CITY_DEBUG__.warMuseum(),
  museum: window.__CITY_DEBUG__.museum(),
}));
fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify(state, null, 1));
console.log(JSON.stringify(state));

const shot = async (name) => {
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, name), timeout: 180_000 });
  console.log('shot', name);
};

await shot('01-focus.png');
await page.evaluate(() => {
  const app = window.__CITY_APP__.app;
  app.setCameraSettings({ orthoHeight: 45 });
});
await shot('02-close.png');
await page.evaluate(() => {
  const app = window.__CITY_APP__.app;
  app.setCameraSettings({ orthoHeight: 28 });
  app.focusOnLocal(-1584.04, 1646.18);
});
await shot('03-detail.png');

fs.writeFileSync(path.join(OUT, 'console.log'), consoleLines.join('\n'));
await browser.close();
