/**
 * Diagnose the museum layer inside the running app.
 * Usage: node scripts/qa/museum-diagnose.mjs [baseUrl]
 */
import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'],
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
page.on('console', (m) => console.log(`[console:${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('requestfailed', (r) => console.log('[requestfailed]', r.url(), r.failure()?.errorText));
page.on('response', (r) => {
  if (r.url().includes('/data/museum')) console.log('[response]', r.status(), r.url());
});

await page.goto(`${BASE}/?dataset=city&focus=lipki`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 120_000 });
console.log('ready; keys:', await page.evaluate(() => Object.keys(window.__CITY_APP__)));
console.log('museum type:', await page.evaluate(() => typeof window.__CITY_DEBUG__.museum));
console.log('museum:', await page.evaluate(() => {
  try {
    return window.__CITY_DEBUG__.museum?.() ?? null;
  } catch (error) {
    return { threw: String(error) };
  }
}));
await page.waitForTimeout(4000);
console.log('museum after 4s:', await page.evaluate(() => {
  try {
    return window.__CITY_DEBUG__.museum?.() ?? null;
  } catch (error) {
    return { threw: String(error) };
  }
}));
console.log('diagnostics:', await page.evaluate(() => window.__CITY_DEBUG__.diagnostics?.() ?? null));
await browser.close();
