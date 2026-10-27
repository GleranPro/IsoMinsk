// Lead integration check: verifies the interactive requirements end-to-end in a
// real browser against the real data. Temporary QA harness (not shipped).
import { chromium } from '@playwright/test';

const URL = process.env.APP_URL || 'http://127.0.0.1:5173/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

const stats = () => page.evaluate(() => window.__CITY_STATS__ ?? window.__CITY_APP__.stats ?? null);
const meanLuminance = (buf) =>
  page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const c2 = document.createElement('canvas'); c2.width = img.width; c2.height = img.height;
    const ctx = c2.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c2.width, c2.height).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; }
    return sum / n;
  }, 'data:image/png;base64,' + buf.toString('base64'));

const t0 = Date.now();
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__CITY_APP__?.ready === true, { timeout: 90000 });
const loadMs = Date.now() - t0;
await page.waitForTimeout(2500);
check('app boots and becomes ready', true, `${loadMs} ms`);

const initial = await stats();
check('real Minsk buildings rendered', !!initial && initial.buildings > 400, `${initial && initial.buildings} buildings`);
check('geometry above 50k triangles', !!initial && initial.triangles > 50000, `${initial && initial.triangles} tris`);
check('draw calls stay low (batched)', !!initial && initial.drawCalls < 120, `${initial && initial.drawCalls} calls`);

// non-flat canvas: measure colour variance from a real screenshot
const varianceShot = await page.screenshot();
const varianceInfo = await page.evaluate(async (dataUrl) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const c2 = document.createElement('canvas'); c2.width = img.width; c2.height = img.height;
  const ctx = c2.getContext('2d'); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c2.width, c2.height).data;
  const set = new Set();
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 13) { set.add((d[i] >> 2 << 10) | (d[i + 1] >> 2 << 5) | (d[i + 2] >> 2)); sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; }
  return { unique: set.size, mean: sum / n, w: c2.width, h: c2.height };
}, 'data:image/png;base64,' + varianceShot.toString('base64'));
check('canvas has non-uniform content', varianceInfo.unique > 40, `${varianceInfo.unique} colours, mean ${varianceInfo.mean.toFixed(0)}`);
check('daytime render is bright enough', varianceInfo.mean > 80, `mean luminance ${varianceInfo.mean.toFixed(0)}`);

// pan
const before = await page.screenshot();
await page.mouse.move(800, 450);
await page.mouse.down();
await page.mouse.move(950, 520, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(700);
const after = await page.screenshot();
check('left-drag pans the camera', Buffer.compare(before, after) !== 0);

// zoom
const zoomBefore = await page.evaluate(() => window.__CITY_APP__.app.getCameraSettings().orthoHeight);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(600);
const zoomAfter = await page.evaluate(() => window.__CITY_APP__.app.getCameraSettings().orthoHeight);
check('wheel zooms', Math.abs(zoomAfter - zoomBefore) > 1, `${zoomBefore.toFixed(0)} → ${zoomAfter.toFixed(0)}`);

// rotate with Q
const azBefore = await page.evaluate(() => window.__CITY_APP__.app.getCameraSettings().azimuth);
await page.keyboard.down('q');
await page.waitForTimeout(600);
await page.keyboard.up('q');
await page.waitForTimeout(300);
const azAfter = await page.evaluate(() => window.__CITY_APP__.app.getCameraSettings().azimuth);
check('Q rotates the camera', Math.abs(azAfter - azBefore) > 0.05, `${azBefore.toFixed(2)} → ${azAfter.toFixed(2)}`);

// reset
await page.click('[data-testid="reset-camera"]');
await page.waitForTimeout(600);
const reset = await page.evaluate(() => window.__CITY_APP__.app.getCameraSettings());
check('reset restores isometric view', Math.abs(reset.azimuth - Math.PI / 4) < 0.01 && reset.orthoHeight > 100,
  `azimuth ${reset.azimuth.toFixed(2)}, ortho ${reset.orthoHeight.toFixed(0)}`);

// pixel toggle
const pixBefore = await page.screenshot();
await page.click('[data-testid="toggle-pixel"]');
await page.waitForTimeout(800);
const pixAfter = await page.screenshot();
check('pixel-art toggle changes rendering', Buffer.compare(pixBefore, pixAfter) !== 0);
await page.click('[data-testid="toggle-pixel"]');
await page.waitForTimeout(400);

// time of day
const day = await page.screenshot();
await page.evaluate(() => window.__CITY_APP__.app.setTimeOfDay(23));
await page.waitForTimeout(1300);
const night = await page.screenshot();
check('time of day changes lighting', Buffer.compare(day, night) !== 0);
const dayL = await meanLuminance(day);
const nightL = await meanLuminance(night);
check('night is darker than day', nightL < dayL * 0.75, `day ${dayL.toFixed(0)} vs night ${nightL.toFixed(0)}`);
await page.evaluate(() => window.__CITY_APP__.app.setTimeOfDay(13));
await page.waitForTimeout(800);

// building picking
await page.click('[data-testid="reset-camera"]');
await page.waitForTimeout(600);
let picked = null;
for (const [dx, dy] of [[0, 0], [120, 80], [-140, 60], [60, -90], [-60, -140], [200, 150], [-220, -120], [300, -60], [-300, 120]]) {
  await page.mouse.click(800 + dx, 450 + dy);
  await page.waitForTimeout(350);
  picked = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="info-panel"]');
    const id = document.querySelector('[data-testid="info-osm-id"]');
    return panel && id ? { id: id.textContent.trim() } : null;
  });
  if (picked) break;
}
check('clicking a building opens the info panel', !!picked, picked ? `OSM id ${picked.id}` : 'no pick at test points');
if (picked) {
  check('picked id is a stable OSM feature id', /^[wr]\d+$/.test(picked.id), picked.id);
  await page.click('[data-testid="info-panel"] .close');
}

// streaming: move far away at close zoom, the resident tile set should shrink
await page.evaluate(() => { const a = window.__CITY_APP__.app; a.setCameraSettings({ orthoHeight: 90 }); a.focusOnLocal(-780, -780); });
await page.waitForTimeout(3500);
const cornerStats = await stats();
check('tile streaming keeps the resident set bounded when zoomed in',
  !!cornerStats && cornerStats.loadedTiles <= (initial ? initial.loadedTiles : 16),
  `overview ${initial && initial.loadedTiles} → close ${cornerStats && cornerStats.loadedTiles}, visible ${cornerStats && cornerStats.visibleTiles}`);

// facade detail toggle
await page.click('[data-testid="toggle-facades"]');
await page.waitForTimeout(600);
await page.click('[data-testid="toggle-facades"]');
check('facade detail toggle does not crash', errors.length === 0);

check('no page/console errors during the whole session', errors.length === 0, errors.slice(0, 3).join(' | '));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} integration checks passed`);
if (passed !== results.length) process.exitCode = 1;
await browser.close();
