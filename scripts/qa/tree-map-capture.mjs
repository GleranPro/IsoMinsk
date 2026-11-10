// Real-map visual regression views, same cameras for legacy and selected trees.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = process.argv[2] || 'screenshots/tree-instancing/map';
const base = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const style = process.env.QA_TREE_STYLE || 'asymmetric';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error' && !/favicon/.test(message.text())) errors.push(message.text()); });
  await page.goto(`${base}/?dataset=city&nolimit=1&treeStyle=${style}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 180000 });
  await page.waitForFunction(() => window.__CITY_APP__?.app?.getStats().loadedTiles === 144, null, { timeout: 180000 });
  await page.addStyleTag({ content: '.hud-topleft,.controls,.info-panel{display:none!important}' });
  const views = [
    { name: 'overview', x: 0, y: 0, zoom: 2600 },
    { name: 'gorky-park', x: 809, y: 108, zoom: 420 },
    { name: 'gorky-trees', x: 680, y: 220, zoom: 130 },
    { name: 'chelyuskintsev', x: 3702, y: 2138, zoom: 200 },
  ];
  const records = [];
  for (const view of views) {
    await page.evaluate(v => {
      const app = window.__CITY_APP__.app;
      app.focusOnLocal(v.x, v.y);
      app.setCameraSettings({ orthoHeight: v.zoom, azimuth: Math.PI / 4 });
      app.setTimeOfDay(13);
    }, view);
    await page.waitForTimeout(1500);
    const file = `${style}-${view.name}.png`;
    await page.screenshot({ path: path.join(out, file) });
    records.push({ ...view, file, stats: await page.evaluate(() => window.__CITY_APP__.app.getStats()) });
  }
  await writeFile(path.join(out, `${style}-records.json`), JSON.stringify({ style, records, errors }, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Saved ${style} real-map views to ${out}`);
} finally { await browser.close(); }
