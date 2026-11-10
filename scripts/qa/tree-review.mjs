// Capture all candidates through the real lighting, shadows and pixel-art pipeline.
// pnpm dev; node scripts/qa/tree-review.mjs [screenshots/tree-instancing/review]
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = process.argv[2] || 'screenshots/tree-instancing/review';
const base = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
const styles = ['faceted', 'clustered', 'asymmetric'];
const views = [
  { name: 'specimens', x: 256, y: 180, zoom: 43, label: 'Отдельные деревья · полный уровень' },
  { name: 'avenue', x: 256, y: 290, zoom: 62, label: 'Уличный ряд · полный уровень' },
  { name: 'forest', x: 768, y: 250, zoom: 125, label: 'Плотный парк · упрощённый уровень' },
];
const names = { faceted: 'A · Цельная гранёная', clustered: 'B · Несколько объёмов', asymmetric: 'C · Асимметричная' };
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const records = [];
try {
  for (const style of styles) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error' && !/favicon/.test(message.text())) errors.push(message.text()); });
    await page.goto(`${base}/?treeReview=1&treeStyle=${style}&nolimit=1&time=13`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__CITY_APP__?.ready === true);
    // Keep the specimens unobstructed and avoid labelling synthetic data as OSM.
    await page.addStyleTag({ content: '.hud,.attribution-wrap,.loading-overlay{display:none!important}' });
    for (const view of views) {
      await page.evaluate(v => {
        const app = window.__CITY_APP__.app;
        app.focusOnLocal(v.x, v.y);
        app.setCameraSettings({ orthoHeight: v.zoom, azimuth: Math.PI / 4 });
      }, view);
      await page.waitForTimeout(1000);
      const file = `${style}-${view.name}.png`;
      await page.locator('canvas').screenshot({ path: path.join(out, file) });
      records.push({ style, view: view.name, file, stats: await page.evaluate(() => window.__CITY_DEBUG__.trees()) });
    }
    await page.close();
    if (errors.length) throw new Error(errors.join('\n'));
  }
  await writeFile(path.join(out, 'records.json'), JSON.stringify(records, null, 2));
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Деревья — сравнение</title>
  <style>body{background:#1c242b;color:#eee;font:16px system-ui;margin:24px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}img{width:100%;display:block}h2{font-size:17px}p{color:#b9c5ce}a{color:inherit}</style>
  <h1>Три направления деревьев</h1><p>Одинаковые данные, камеры, свет 13:00 и пиксельный рендер. Синтетические посадки для сравнения; это не новые данные OSM. Нажмите изображение для полного размера.</p><main>
  ${views.map(v => styles.map(s => `<section><h2>${names[s]}</h2><p>${v.label}</p><a href="${s}-${v.name}.png"><img src="${s}-${v.name}.png"></a></section>`).join('')).join('')}</main></html>`;
  await writeFile(path.join(out, 'index.html'), html);
  console.log(`Saved 9 review views to ${out}`);
} finally { await browser.close(); }
