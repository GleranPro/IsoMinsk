/**
 * Nested-path release check for the assembled GitHub Pages artifact (Task 10).
 *
 * The artifact is produced by:
 *   pnpm run build
 *   node scripts/qa/build-pages.mjs --dist dist --site .pages --city-dir public/data/city-tiles
 *   node scripts/qa/publication-audit.mjs --site .pages
 *
 * When `.pages/` is absent the suite is skipped **explicitly** (the reason is
 * part of the suite name) — it must never silently pass a broken nested path.
 * When the artifact exists, every checked route must be served below
 * `/VoxelMinsk/`, legacy dataset paths must 404, and the application shell must
 * boot without root-relative asset requests.
 *
 * Run: pnpm exec playwright test tests/e2e/publication.spec.ts
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  DEFAULT_NESTED_BASE,
  SITE_MANIFEST_NAME,
  startNestedStaticServer,
  type NestedStaticServer,
} from '../../src/qa/publication.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SITE_ROOT = path.join(ROOT, '.pages');

const ARTIFACT_PRESENT =
  existsSync(path.join(SITE_ROOT, 'index.html')) && existsSync(path.join(SITE_ROOT, SITE_MANIFEST_NAME));
const SKIP_REASON =
  '<.pages/ artifact absent: run "pnpm run build" then "node scripts/qa/build-pages.mjs --dist dist --site .pages --city-dir public/data/city-tiles">';

const publicationDescribe = ARTIFACT_PRESENT ? test.describe : test.describe.skip;

publicationDescribe(`nested-path release check ${ARTIFACT_PRESENT ? '' : `(skipped: ${SKIP_REASON})`}`, () => {
  let server!: NestedStaticServer;

  test.beforeAll(async () => {
    server = await startNestedStaticServer({ siteRoot: SITE_ROOT, basePath: DEFAULT_NESTED_BASE });
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('serves index, city payload, mobility payload, museum payload and licence notices below the prefix', async ({ request }) => {
    const get = async (route: string) => {
      const response = await request.get(`${server.baseUrl}${route}`);
      expect(response.status(), `${route} below ${DEFAULT_NESTED_BASE}`).toBe(200);
      return response;
    };

    const index = await get('');
    const html = await index.text();
    expect(html).toContain('id="root"');
    const scriptSources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
    expect(scriptSources.length, 'index.html must reference a module bundle').toBeGreaterThan(0);
    for (const source of scriptSources) {
      expect(source.startsWith('/'), `absolute script URL breaks project-path hosting: ${source}`).toBe(false);
    }
    await get(scriptSources[0].replace(/^\.\//, ''));

    const siteManifest = await (await get(SITE_MANIFEST_NAME)).json();
    expect(siteManifest.schemaVersion).toBe(1);
    expect(Array.isArray(siteManifest.files)).toBe(true);

    const city = await (await get('data/city-tiles/manifest.json')).json();
    expect(city.tiles.length).toBe(siteManifest.city.tileCount);
    expect(city.tiles.length).toBeGreaterThan(0);
    const firstTileEntry = city.tiles[0];
    const firstTile = await (await get(`data/city-tiles/${firstTileEntry.file.split('/').pop()}`)).json();
    expect(firstTile.tileX).toBe(firstTileEntry.x);
    expect(firstTile.tileY).toBe(firstTileEntry.y);
    expect(Array.isArray(firstTile.buildings)).toBe(true);

    const museum = await (await get('data/museum/manifest.json')).json();
    expect(Array.isArray(museum.exhibits)).toBe(true);
    const exhibits = await get('data/museum/exhibits.bin');
    expect((await exhibits.body()).byteLength).toBe(museum.byteLength);

    const mobility = await (await get('data/mobility/manifest.json')).json();
    expect(mobility.counts.stops).toBeGreaterThan(0);
    expect(Array.isArray(mobility.chunks)).toBe(true);
    const firstChunk = mobility.chunks?.[0];
    expect(firstChunk?.file, 'mobility manifest must index its chunks').toBeTruthy();
    const chunk = await (await get(`data/mobility/${firstChunk.file.replace(/^\/+/, '')}`)).json();
    expect(chunk.version).toBe(mobility.version);

    expect(await (await get('data/ATTRIBUTION.md')).text()).toContain('OpenStreetMap');
    expect(await (await get('data/LICENSE-ODbL.txt')).text()).toContain('Open Database License');
    const licences = await (await get('asset-licenses.json')).json();
    expect(Array.isArray(licences.entries)).toBe(true);
    expect(licences.entries.length).toBeGreaterThan(0);
  });

  test('never exposes legacy or alternate datasets', async ({ request }) => {
    for (const route of ['data/tiles/manifest.json', 'data/city-tiles-current/manifest.json', 'data/city-tiles-b2/manifest.json', 'data/mobility-city/manifest.json']) {
      const response = await request.get(`${server.baseUrl}${route}`);
      expect([403, 404], `${route} must not be published`).toContain(response.status());
    }
    const rootData = await request.get(`${server.origin}/data/city-tiles/manifest.json`);
    expect([403, 404], 'the artifact must not answer at the host root').toContain(rootData.status());
  });

  test('boots the application shell from the nested prefix', async ({ page }) => {
    const badShellResponses: string[] = [];
    const rootAssetRequests: string[] = [];
    page.on('response', (response) => {
      const type = response.request().resourceType();
      if (['document', 'script', 'stylesheet'].includes(type) && response.status() >= 400) {
        badShellResponses.push(`${response.status()} ${type} ${response.url()}`);
      }
    });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === server.origin && /^\/(?:assets|data)\//.test(url.pathname)) {
        rootAssetRequests.push(request.url());
      }
    });

    const response = await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), `document at ${server.baseUrl}`).toBe(200);
    await expect(page.locator('[data-testid="attribution-badge"]')).toBeVisible({ timeout: 60_000 });
    expect(rootAssetRequests, 'the app must resolve every asset below the project prefix').toEqual([]);
    expect(badShellResponses, 'the application shell must load cleanly').toEqual([]);
  });
});
