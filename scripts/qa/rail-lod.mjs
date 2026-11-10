// Same data, camera, lighting and display size; only ground texel size changes.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const label = process.argv[2] || 'after';
const out = 'screenshots/rail-lod';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/rail-qa', route => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#18202a;color:white;font:16px system-ui"></body>' }));
  await page.goto(`${process.env.QA_BASE_URL || 'http://127.0.0.1:5173'}/rail-qa`);
  const metrics = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { rasterizeGround } = await import('/src/city/ground/groundRaster.ts');
    const { createGroundTexture, createGroundQuad } = await import('/src/engine/materials/groundMaterial.ts');
    const real = await (await fetch('/data/city-tiles/-1_-2.json')).json();
    const synthetic = {
      tileX: 0, tileY: 0, bounds: [0, 0, 256, 256], buildings: [], roads: [], trees: [], surfaces: [],
      ground: { version: 2, strokes: [
        { k: 'rail', c: 'unknown', w: 3.5, p: [16, 64, 240, 64], s0: 0, r: 0 },
        { k: 'rail', c: 'unknown', w: 3.5, p: [16, 120, 120, 180, 240, 200], s0: 0, r: 0 },
        { k: 'tram', c: 'unknown', w: 2.2, p: [16, 224, 240, 224], s0: 0, r: 0 },
      ] },
    };
    const records = [];
    for (const [name, tile, height] of [['controlled tracks (synthetic)', synthetic, 160], ['Minsk station (OSM)', real, 640]]) {
      const heading = document.createElement('h3');
      heading.textContent = name;
      heading.style.margin = '8px 16px';
      document.body.append(heading);
      const row = document.createElement('div');
      row.style.display = 'flex';
      document.body.append(row);
      for (const res of [0.5, 1, 4]) {
        const cell = document.createElement('div');
        const caption = document.createElement('div');
        caption.textContent = `${res} m/texel — same camera`;
        caption.style.textAlign = 'center';
        cell.append(caption);
        row.append(cell);
        const raster = rasterizeGround(tile, tile.bounds, res);
        const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
        renderer.setSize(480, 370);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        cell.append(renderer.domElement);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#18202a');
        const texture = createGroundTexture(raster.data.buffer, raster.width, raster.height);
        const geometry = createGroundQuad(tile.bounds, 0);
        const material = new THREE.MeshBasicMaterial({ map: texture });
        scene.add(new THREE.Mesh(geometry, material));
        const cx = (tile.bounds[0] + tile.bounds[2]) / 2, cy = (tile.bounds[1] + tile.bounds[3]) / 2;
        const camera = new THREE.OrthographicCamera(-height * 480 / 370, height * 480 / 370, height, -height, 1, 10000);
        camera.position.set(cx + 1500, 2000, -cy + 1500);
        camera.lookAt(cx, 0, -cy);
        renderer.render(scene, camera);
        if (tile === synthetic) {
          // Mean colour in a fixed world-space corridor: catches whole-texel
          // widening and colour substitution without relying on screenshots.
          const rgb = [0, 0, 0];
          let count = 0;
          for (let y = Math.floor((256 - 72) / res); y < Math.floor((256 - 56) / res); y++) {
            for (let x = Math.floor(24 / res); x < Math.floor(232 / res); x++) {
              const i = (y * raster.width + x) * 4;
              for (let c = 0; c < 3; c++) rgb[c] += raster.data[i + c];
              count++;
            }
          }
          records.push({ res, meanCorridorRgb: rgb.map(c => c / count) });
        }
        renderer.dispose(); geometry.dispose(); material.dispose(); texture.dispose();
      }
    }
    return records;
  });
  await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true });
  await writeFile(path.join(out, `${label}.json`), JSON.stringify({ metrics, errors }, null, 2));
  console.log(JSON.stringify({ label, metrics, errors }));
  if (process.env.QA_RAIL_APP === '1') {
    await page.goto(`${process.env.QA_BASE_URL || 'http://127.0.0.1:5173'}/?dataset=city&nolimit=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__CITY_APP__?.ready && window.__CITY_APP__.app.getStats().loadedTiles === 144,
      null, { timeout: 180000 });
    await page.addStyleTag({ content: '.hud-topleft,.controls,.info-panel{display:none!important}' });
    const views = [];
    for (const [name, orthoHeight, textureWidth] of [
      ['overview', 900, 256], ['base', 350, 1024], ['fine', 100, 2048],
      ['base-return', 350, 1024], ['overview-return', 900, 256],
    ]) {
      await page.evaluate(height => {
        const app = window.__CITY_APP__.app;
        app.focusOnLocal(-500, -1550);
        app.setCameraSettings({ orthoHeight: height, azimuth: Math.PI / 4 });
        app.setTimeOfDay(13);
      }, orthoHeight);
      await page.waitForFunction(expected => {
        const root = window.__CITY_DEBUG__.cityRootObject();
        return root.getObjectByName('ground--1_-2')?.material.map.image.width === expected;
      }, textureWidth, { timeout: 60000 });
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(out, `${label}-app-${name}.png`) });
      views.push(await page.evaluate(({ name, textureWidth }) => ({ name, textureWidth,
        camera: window.__CITY_APP__.app.getCameraSettings(),
        groundTiers: window.__CITY_DEBUG__.scene().groundTiers,
        diagnostics: window.__CITY_DEBUG__.diagnostics(),
      }), { name, textureWidth }));
    }
    await writeFile(path.join(out, `${label}-app.json`), JSON.stringify({ views, errors }, null, 2));
    if (views.some(view => view.diagnostics.some(d => /ground LOD failed/.test(d)))) throw new Error('Ground LOD failed');
    console.log(`Verified actual worker LOD transitions: ${views.map(v => v.textureWidth).join(' -> ')}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser.close(); }
