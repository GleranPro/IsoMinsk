import { chromium } from '@playwright/test';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__CITY_APP__?.ready === true, { timeout: 90000 });
await page.waitForTimeout(2500);
await page.evaluate(() => { const a = window.__CITY_APP__.app; a.resetCamera(); a.setCameraSettings({ orthoHeight: 560, azimuth: Math.PI/4 }); a.setTimeOfDay(13); });
await page.waitForTimeout(1500);
const buf = await page.screenshot();
const fs = await import('node:fs');
fs.writeFileSync('screenshots/measure.png', buf);
// decode PNG using chromium itself
const stats = await page.evaluate(async (dataUrl) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, n = 0, nearBlack = 0, max = 0; const colors = new Set();
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
    sum += l; n++; if (l < 20) nearBlack++; if (l > max) max = l;
    if (colors.size < 5000) colors.add((d[i]>>2<<10) | (d[i+1]>>2<<5) | (d[i+2]>>2));
  }
  return { meanLuminance: +(sum/n).toFixed(1), nearBlackPct: +(100*nearBlack/n).toFixed(1), maxLuminance: +max.toFixed(1), approxColors: colors.size };
}, 'data:image/png;base64,' + buf.toString('base64'));
console.log('OVERVIEW METRICS:', JSON.stringify(stats));
await browser.close();
