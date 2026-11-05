// GPU-synced frame-time benchmark of the city dataset (B-1 tree density decision).
//
//   pnpm dev                                   # or any server for this repo
//   QA_BASE_URL=http://127.0.0.1:5173 node scripts/qa/tree-perf.mjs <label> <out.json>
//
// Hardware GPU (ANGLE/D3D11), vsync and the frame-rate limit off, the whole city
// streamed in; then 4 s of frames per view. Every frame reads one pixel back, so
// the time includes the GPU work (plain rAF timing is CPU-paced and hides it).
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const [label = 'run', out = 'perf.json'] = process.argv.slice(2);
const BASE = `${(process.env.QA_BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')}/?dataset=city`;
const VIEWS = [
  { name: 'overview', reset: true, zoom: 2600 },
  { name: 'gorky-park', fx: 809, fy: 108, zoom: 420 },
  { name: 'chelyuskintsev-park', fx: 3702, fy: 2138, zoom: 700 },
  { name: 'kalvaria-cemetery', fx: -3726, fy: 597, zoom: 420 },
  { name: 'loshitsa-park', fx: 1303, fy: -5184, zoom: 700 },
  { name: 'victory-park', fx: -1617, fy: 2278, zoom: 700 },
];
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu',
         '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const t0 = Date.now();
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__CITY_APP__?.ready === true, null, { timeout: 180000 });
const expected = await page.evaluate(async () => (await (await fetch('/data/city-tiles/manifest.json')).json()).tiles.length);
await page.waitForFunction((n) => window.__CITY_APP__.app.getStats().loadedTiles >= n, expected, { timeout: 300000, polling: 500 });
const loadS = (Date.now() - t0) / 1000;
const gpu = await page.evaluate(() => {
  const gl = document.querySelector('canvas').getContext('webgl2');
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});
const results = [];
for (const view of VIEWS) {
  await page.evaluate((v) => {
    const app = window.__CITY_APP__.app;
    if (v.reset) app.resetCamera();
    if (v.fx !== undefined) app.focusOnLocal(v.fx, v.fy);
    app.setCameraSettings({ orthoHeight: v.zoom, azimuth: Math.PI / 4 });
    app.setTimeOfDay(13);
  }, view);
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => new Promise((resolve) => {
    const gl = document.querySelector('canvas').getContext('webgl2');
    const px = new Uint8Array(4);
    const deltas = []; let last = performance.now(); const end = last + 4000;
    function tick(now) {
      // Reading one pixel blocks until the GPU has finished the previous frame,
      // so the frame time includes GPU work (rAF alone is CPU-paced).
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      now = performance.now();
      deltas.push(now - last); last = now;
      if (now < end) requestAnimationFrame(tick);
      else {
        deltas.shift(); deltas.sort((a, b) => a - b);
        const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        resolve({ frames: deltas.length, meanMs: +mean.toFixed(2), p95Ms: +deltas[Math.floor(deltas.length * 0.95)].toFixed(2), fps: +(1000 / mean).toFixed(1) });
      }
    }
    requestAnimationFrame(tick);
  }));
  const s = await page.evaluate(() => window.__CITY_APP__.app.getStats());
  results.push({ view: view.name, ...m, triangles: s.triangles, drawCalls: s.drawCalls, geometryMB: s.geometryMB });
  console.log(`${label} ${view.name.padEnd(20)} mean ${m.meanMs} ms  p95 ${m.p95Ms} ms  ${m.fps} fps  tris ${s.triangles}  draws ${s.drawCalls}  geomMB ${s.geometryMB}`);
}
const heap = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
console.log(`${label} gpu=${gpu} load=${loadS}s tiles=${expected} jsHeapMB=${heap}`);
writeFileSync(out, JSON.stringify({ label, gpu, loadS, heap, results }, null, 1));
await browser.close();
