/**
 * Publication contract tests (Tasks 10-11).
 *
 * These tests pin the static Pages artifact contract and the licensing gate
 * implemented in `src/qa/publication.ts`, which is shared by
 * `scripts/qa/build-pages.mjs` and `scripts/qa/publication-audit.mjs`.
 *
 * The complete-city tile payload is git-ignored and generated locally
 * (`pnpm run data:city`). When it is absent the complete-city block is skipped
 * with an explicit reason instead of silently passing; `build-pages.mjs` still
 * fails closed if it cannot find the accepted city manifest.
 *
 * Run: pnpm exec vitest run tests/unit/publication.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FATAL_TOTAL_BYTES,
  SITE_MANIFEST_NAME,
  WARNING_THRESHOLD_BYTES,
  auditArtifact,
  classifyArtifactSize,
  createArtifactManifest,
  loadAssetLicenses,
  manifestMismatch,
  planArtifact,
  planWhitelistAdditions,
  scanForbiddenContent,
  startNestedStaticServer,
  validateArtifactPaths,
  validateAssetLicenses,
  validateCityPayload,
  walkFiles,
  type ArtifactEntry,
  type ArtifactManifest,
} from '../../src/qa/publication.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CITY_DIR = path.join(PUBLIC, 'data', 'city-tiles');
const CITY_MANIFEST_PATH = path.join(CITY_DIR, 'manifest.json');
const MUSEUM_MANIFEST_PATH = path.join(PUBLIC, 'data', 'museum', 'manifest.json');
const ASSET_LICENSES_PATH = path.join(PUBLIC, 'asset-licenses.json');
const ATTRIBUTION_PATH = path.join(PUBLIC, 'data', 'ATTRIBUTION.md');
const ODBL_PATH = path.join(PUBLIC, 'data', 'LICENSE-ODbL.txt');
const MODELS_PATH = path.join(ROOT, 'assets', 'aviation-museum', 'MODELS.json');

const completeCityAvailable = existsSync(CITY_MANIFEST_PATH);
const temporaryRoots: string[] = [];

function makeTempRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `publication-${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function writeFile(root: string, relativePath: string, content: string | Buffer): string {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function entryAt(root: string, relativePath: string): ArtifactEntry {
  const sourcePath = path.join(root, relativePath);
  return { sitePath: relativePath, sourcePath, bytes: statSync(sourcePath).size };
}

function codes(problems: { code: string }[]): string[] {
  return problems.map((problem) => problem.code);
}

/** A minimal but complete, self-consistent artifact used to test fail-closed behavior. */
interface FixtureSite {
  root: string;
  entries: ArtifactEntry[];
  manifest: ArtifactManifest;
  cityManifestPath: string;
}

function buildFixtureSite(): FixtureSite {
  const root = makeTempRoot('fixture');
  writeFile(root, 'index.html', '<!doctype html><html><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>');
  writeFile(root, 'assets/app.js', 'export const notice = "OpenStreetMap contributors · ODbL 1.0";');
  writeFile(root, '.nojekyll', '');
  writeFile(root, 'asset-licenses.json', readFileSync(ASSET_LICENSES_PATH));
  writeFile(root, 'data/ATTRIBUTION.md', readFileSync(ATTRIBUTION_PATH));
  writeFile(root, 'data/LICENSE-ODbL.txt', readFileSync(ODBL_PATH));

  const tileBody = '{"buildings":[{"id":1}],"roads":[]}';
  writeFile(root, 'data/city-tiles/0_0.json', tileBody);
  const cityManifest = {
    version: 'fixture-0',
    generatedAt: '2026-11-14',
    tileRange: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    tiles: [{ x: 0, y: 0, file: '0_0.json', buildings: 1, bytes: Buffer.byteLength(tileBody) }],
    counts: { buildings: 1, trees: 0 },
    attribution: [{ name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright', licence: 'ODbL 1.0' }],
  };
  const cityManifestPath = writeFile(root, 'data/city-tiles/manifest.json', JSON.stringify(cityManifest));
  writeFile(root, 'data/museum/exhibits.bin', Buffer.from([1, 2, 3, 4]));
  writeFile(
    root,
    'data/museum/manifest.json',
    JSON.stringify({ version: 1, byteLength: 4, vertices: 0, triangles: 0, exhibits: [], missing: [], sections: [] }),
  );
  writeFile(
    root,
    'data/mobility/manifest.json',
    JSON.stringify({ version: 1, release: { bindings: 'b', network: 'n', schedule: 's' }, generatedAt: 'fixture', counts: { chunks: 1, routes: 0 } }),
  );
  writeFile(
    root,
    'data/mobility/chunks/0_0.json',
    JSON.stringify({ version: 1, key: '0_0', bounds: [0, 0, 1, 1], edges: [], signals: [], stops: [] }),
  );

  const entries = walkFiles(root);
  const manifest = createArtifactManifest(entries, { cityManifestPath, commitSha: 'fixture-commit' });
  return { root, entries, manifest, cityManifestPath };
}

describe('publication thresholds', () => {
  it('uses 500 MiB as the warning threshold and 900 MB as the fatal artifact error', () => {
    expect(WARNING_THRESHOLD_BYTES).toBe(500 * 2 ** 20);
    expect(FATAL_TOTAL_BYTES).toBe(900_000_000);
    expect(WARNING_THRESHOLD_BYTES).toBeLessThan(FATAL_TOTAL_BYTES);
  });

  it('classifies the warning/fatal boundary without truncating the dataset', () => {
    expect(classifyArtifactSize(WARNING_THRESHOLD_BYTES - 1)).toEqual({ warning: false, fatalError: false });
    expect(classifyArtifactSize(WARNING_THRESHOLD_BYTES)).toEqual({ warning: true, fatalError: false });
    expect(classifyArtifactSize(FATAL_TOTAL_BYTES - 1)).toEqual({ warning: true, fatalError: false });
    expect(classifyArtifactSize(FATAL_TOTAL_BYTES)).toEqual({ warning: true, fatalError: true });
  });
});

const describeCompleteCity = completeCityAvailable ? describe : describe.skip;
const COMPLETE_CITY_LABEL = completeCityAvailable
  ? 'complete-city artifact contract'
  : 'complete-city artifact contract (skipped: public/data/city-tiles/manifest.json is absent — run pnpm run data:city)';

describeCompleteCity(COMPLETE_CITY_LABEL, () => {
  let entries: ArtifactEntry[];
  let manifest: ArtifactManifest;

  beforeAll(() => {
    entries = planWhitelistAdditions({ repoRoot: ROOT, cityDir: CITY_DIR });
    manifest = createArtifactManifest(entries, { cityManifestPath: CITY_MANIFEST_PATH, commitSha: 'test-commit' });
  }, 180_000);

  function sourceBySitePath(): Map<string, ArtifactEntry> {
    return new Map(entries.map((entry) => [entry.sitePath, entry]));
  }

  it('contains one complete city and no alternate/reduced dataset', () => {
    expect(manifest.directories).toContain('data/city-tiles');
    expect(manifest.directories).toContain('data/museum');
    expect(manifest.directories).not.toContain('data/tiles');
    expect(manifest.directories).not.toContain('data/city-tiles-current');
    expect(manifest.directories).not.toContain('data/city-tiles-b2');
    expect(manifest.totalBytes).toBeLessThan(900_000_000);
    expect(manifest.warningThresholdBytes).toBe(500 * 2 ** 20);
    expect(manifest.fatalError).toBe(manifest.totalBytes >= 900_000_000);
    expect(manifest.fatalError).toBe(false);
    expect(manifest.warning).toBe(manifest.totalBytes >= WARNING_THRESHOLD_BYTES);
    expect(manifest.totalBytes).toBe(entries.reduce((sum, entry) => sum + entry.bytes, 0));
    expect(validateArtifactPaths(entries)).toEqual([]);
  });

  it('lists every artifact file path-sorted with its exact byte count', () => {
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).not.toContain(SITE_MANIFEST_NAME);
    const sources = sourceBySitePath();
    for (const file of manifest.files) {
      const source = sources.get(file.path);
      expect(source, `missing plan entry for ${file.path}`).toBeTruthy();
      expect(statSync(source!.sourcePath).size, `byte count for ${file.path}`).toBe(file.bytes);
    }
  });

  it('ships the accepted tile addresses and byte counts, not a stale copy', () => {
    const city = JSON.parse(readFileSync(CITY_MANIFEST_PATH, 'utf8')) as {
      tiles: { x: number; y: number; file: string; bytes: number }[];
      tileRange: { minX: number; minY: number; maxX: number; maxY: number };
    };
    const sources = sourceBySitePath();
    const tileEntries = entries.filter(
      (entry) => entry.sitePath.startsWith('data/city-tiles/') && entry.sitePath !== 'data/city-tiles/manifest.json',
    );
    const expectedTiles = (city.tileRange.maxX - city.tileRange.minX + 1) * (city.tileRange.maxY - city.tileRange.minY + 1);
    expect(tileEntries.length).toBe(expectedTiles);
    expect(city.tiles.length).toBe(expectedTiles);
    expect(manifest.counts.cityTiles).toBe(expectedTiles);
    expect(manifest.counts.cityTileFiles).toBe(expectedTiles + 1);
    expect(manifest.counts.museumFiles).toBe(2);
    expect(manifest.counts.mobilityFiles).toBeGreaterThan(0);

    const accepted = new Map<string, number>();
    for (const tile of city.tiles) {
      const name = tile.file.replace(/^tiles\//, '');
      expect(name).toBe(`${tile.x}_${tile.y}.json`);
      accepted.set(name, tile.bytes);
    }
    for (const entry of tileEntries) {
      const name = path.posix.basename(entry.sitePath);
      expect(accepted.has(name), `unexpected tile ${name}`).toBe(true);
      expect(entry.bytes, `bytes of ${name}`).toBe(accepted.get(name));
      expect(sourceBySitePath().get(`data/city-tiles/${name}`)?.sourcePath).toBe(path.join(CITY_DIR, name));
    }
    expect(validateCityPayload(entries, CITY_MANIFEST_PATH, manifest.city)).toEqual([]);
  });

  it('contains no raw/interim/worktree/backup files and no credential-like content', () => {
    expect(scanForbiddenContent(entries)).toEqual([]);
  }, 180_000);

  it('ships the OSM/ODbL notices and attribution', () => {
    const paths = new Set(manifest.files.map((file) => file.path));
    for (const required of ['.nojekyll', 'asset-licenses.json', 'data/ATTRIBUTION.md', 'data/LICENSE-ODbL.txt', 'data/city-tiles/manifest.json', 'data/museum/manifest.json', 'data/museum/exhibits.bin', 'data/mobility/manifest.json']) {
      expect(paths.has(required), `artifact is missing ${required}`).toBe(true);
    }
    const attribution = readFileSync(ATTRIBUTION_PATH, 'utf8');
    expect(attribution).toContain('OpenStreetMap');
    expect(attribution).toContain('OpenStreetMap contributors');
    expect(attribution).toMatch(/ODbL 1\.0/);
    expect(attribution).toContain('data/city-tiles');
    const licence = readFileSync(ODBL_PATH, 'utf8');
    expect(licence).toContain('Open Data Commons');
    expect(licence).toContain('Open Database License');
    expect(licence).toMatch(/ODbL/);
  });

  it('names every shipped museum model in the attribution and covers it with a licence entry', () => {
    const museum = JSON.parse(readFileSync(MUSEUM_MANIFEST_PATH, 'utf8')) as { exhibits: { slug: string }[] };
    const models = JSON.parse(readFileSync(MODELS_PATH, 'utf8')) as {
      items: { slug: string; label: string; status: string; author: string | null; license: string | null; uid?: string | null; url?: string | null }[];
    };
    const attribution = readFileSync(ATTRIBUTION_PATH, 'utf8');
    const licences = loadAssetLicenses(ASSET_LICENSES_PATH);
    const licencedSlugs = new Set(licences.entries.filter((entry) => entry.exhibitSlug).map((entry) => entry.exhibitSlug));
    for (const slug of new Set(museum.exhibits.map((exhibit) => exhibit.slug))) {
      const model = models.items.find((item) => item.slug === slug && item.status === 'downloaded');
      expect(model, `museum payload ships ${slug} but MODELS.json has no downloaded record`).toBeTruthy();
      expect(model!.author, `MODELS.json has no author for ${slug}`).toBeTruthy();
      expect(model!.license, `MODELS.json has no licence for ${slug}`).toBeTruthy();
      expect(model!.uid || model!.url, `MODELS.json has no upstream source for ${slug}`).toBeTruthy();
      expect(licencedSlugs.has(slug), `asset-licenses.json does not cover ${slug}`).toBe(true);
      expect(attribution, `ATTRIBUTION.md does not name ${model!.author}`).toContain(model!.author!);
    }
  });

  it('has a schema-valid licence inventory with explicit owner-required unknowns', () => {
    const licences = loadAssetLicenses(ASSET_LICENSES_PATH);
    expect(validateAssetLicenses(licences)).toEqual([]);
    expect(licences.code.status).toBe('owner_required');
    expect(licences.code.license).toBeNull();
    for (const entry of licences.entries.filter((candidate) => candidate.thirdParty)) {
      expect(entry.license, entry.id).toBeTruthy();
      expect(entry.source, entry.id).toBeTruthy();
      expect(typeof entry.modified, entry.id).toBe('boolean');
      expect(entry.attribution, entry.id).toBeTruthy();
      if (entry.redistribution !== true) {
        expect(entry.status, entry.id).toBe('owner_required');
        expect(entry.reason, entry.id).toBeTruthy();
      }
    }
    const osm = licences.entries.find((entry) => /openstreetmap|osm/i.test(`${entry.id} ${entry.name}`));
    expect(osm, 'no OSM-derived database entry').toBeTruthy();
    expect(osm!.license).toMatch(/ODbL/i);
    expect(osm!.redistribution).toBe(true);
    expect(osm!.modified).toBe(true);
  });

  it('passes the artifact audit while keeping the unselected source licence visible', () => {
    const audit = auditArtifact({ repoRoot: ROOT, entries, manifest, requireAppBundle: false });
    expect(audit.errors, JSON.stringify(audit.errors, null, 2)).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.legal.status).toBe('pass_with_owner_required');
    expect(audit.legal.ownerRequired).toContain('source-code-license');
    expect(codes(audit.warnings)).toContain('code-license-owner-required');
    expect(audit.required.every((item) => item.present)).toBe(false);
    expect(audit.required.find((item) => item.path === 'data/ATTRIBUTION.md')?.present).toBe(true);
  }, 180_000);
});

describe('artifact path policy', () => {
  const forbiddenPaths = [
    'data/tiles/-11_-9.json',
    'data/city-tiles-current/-11_-9.json',
    'data/city-tiles-b2/-11_-9.json',
    'data/raw/Minsk.osm.pbf',
    'data/interim/minsk_raw.geojson',
    'data/processed/coverage_city.json',
    'data/staging/city/0_0.json',
    '.worktrees/procedural-building-variety/index.html',
    'screenshots/building-quality/l0.png',
    'test-results/run/.last-run.json',
    'backup.json.bak',
    'backup.orig',
    '.env',
    'assets/keys/id_rsa',
    'assets/server.pem',
    'credentials/aws.json',
  ];

  it('rejects alternate datasets, raw/interim/worktree/backup and credential files', () => {
    for (const sitePath of forbiddenPaths) {
      const problems = validateArtifactPaths([{ sitePath, sourcePath: path.join(tmpdir(), sitePath), bytes: 1 }]);
      expect(problems.length, `expected ${sitePath} to be rejected`).toBeGreaterThan(0);
    }
  });

  it('accepts the whitelisted city, museum and notice layout', () => {
    const allowed = [
      'index.html',
      'assets/index-abc123.js',
      'assets/index-abc123.js.map',
      '.nojekyll',
      'asset-licenses.json',
      'data/ATTRIBUTION.md',
      'data/LICENSE-ODbL.txt',
      'data/city-tiles/manifest.json',
      'data/city-tiles/-11_-9.json',
      'data/museum/manifest.json',
      'data/museum/exhibits.bin',
      'data/mobility/manifest.json',
      'data/mobility/chunks/0_0.json',
    ];
    expect(validateArtifactPaths(allowed.map((sitePath) => ({ sitePath, sourcePath: path.join(tmpdir(), sitePath), bytes: 1 })))).toEqual([]);
  });
});

describe('artifact content scanning', () => {
  it('detects private keys, tokens and secret assignments but ignores ordinary payload JSON', () => {
    const root = makeTempRoot('secrets');
    writeFile(root, 'assets/app.js', 'export const answer = 42; const token = "short";');
    writeFile(root, 'data/city-tiles/0_0.json', '{"buildings":[],"attribution":"OpenStreetMap"}');
    writeFile(root, 'config.json', '{"apiKey": "abcdef0123456789abcdef"}');
    writeFile(root, 'leak.js', `const t = "ghp_${'a'.repeat(36)}";`);
    writeFile(root, 'keys/id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----');
    writeFile(root, '.env', 'SECRET=1');

    const entries = walkFiles(root);
    const pathProblems = validateArtifactPaths(entries);
    expect(codes(pathProblems)).toContain('secret-file-name');
    const contentProblems = scanForbiddenContent(entries);
    expect(codes(contentProblems)).toContain('private-key');
    expect(codes(contentProblems)).toContain('github-token');
    expect(codes(contentProblems)).toContain('secret-assignment');
  });
});

describe('whitelist assembler', () => {
  it('copies built app files while excluding public data, then adds only whitelisted payloads', () => {
    const repo = makeTempRoot('plan');
    writeFile(repo, 'dist/index.html', '<div id="root"></div>');
    writeFile(repo, 'dist/assets/app.js', 'console.log(1);');
    writeFile(repo, 'dist/data/tiles/-1_-1.json', '{"legacy":true}');
    writeFile(repo, 'dist/data/city-tiles/manifest.json', '{"stale":true}');
    for (const relative of [
      'public/.nojekyll',
      'public/asset-licenses.json',
      'public/data/ATTRIBUTION.md',
      'public/data/LICENSE-ODbL.txt',
      'public/data/museum/manifest.json',
      'public/data/museum/exhibits.bin',
      'public/data/mobility/manifest.json',
      'public/data/mobility/chunks/0_0.json',
      'public/data/city-tiles/manifest.json',
      'public/data/city-tiles/0_0.json',
    ]) {
      writeFile(repo, relative, 'x');
    }

    const entries = planArtifact({
      repoRoot: repo,
      distDir: path.join(repo, 'dist'),
      cityDir: path.join(repo, 'public', 'data', 'city-tiles'),
    });
    const paths = entries.map((entry) => entry.sitePath);
    expect(paths).toContain('index.html');
    expect(paths).toContain('assets/app.js');
    expect(paths).toContain('.nojekyll');
    expect(paths).toContain('asset-licenses.json');
    expect(paths).toContain('data/city-tiles/0_0.json');
    expect(paths).toContain('data/city-tiles/manifest.json');
    expect(paths).toContain('data/museum/manifest.json');
    expect(paths).toContain('data/mobility/manifest.json');
    expect(paths).toContain('data/mobility/chunks/0_0.json');
    expect(paths).toContain('data/ATTRIBUTION.md');
    expect(paths).toContain('data/LICENSE-ODbL.txt');
    expect(paths.some((sitePath) => sitePath.startsWith('data/tiles/'))).toBe(false);
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    expect(() =>
      planArtifact({ repoRoot: repo, distDir: path.join(repo, 'missing-dist'), cityDir: path.join(repo, 'public', 'data', 'city-tiles') }),
    ).toThrow(/dist/i);
  });
});

describe('fail-closed artifact audit', () => {
  let fixture: FixtureSite;

  beforeAll(() => {
    fixture = buildFixtureSite();
  });

  it('passes a minimal complete artifact', () => {
    const audit = auditArtifact({ repoRoot: ROOT, entries: fixture.entries, manifest: fixture.manifest });
    expect(audit.errors, JSON.stringify(audit.errors, null, 2)).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('rejects an alternate dataset inside the artifact', () => {
    const legacyPath = writeFile(fixture.root, 'data/tiles/-1_-1.json', '{"legacy":true}');
    const entries = [...fixture.entries, { sitePath: 'data/tiles/-1_-1.json', sourcePath: legacyPath, bytes: statSync(legacyPath).size }];
    const audit = auditArtifact({ repoRoot: ROOT, entries, manifest: fixture.manifest });
    expect(audit.ok).toBe(false);
    expect(codes(audit.errors)).toContain('forbidden-artifact-path');
  });

  it('rejects missing, resized and out-of-range city tiles', () => {
    const missing = fixture.entries.filter((entry) => entry.sitePath !== 'data/city-tiles/0_0.json');
    expect(validateCityPayload(missing, fixture.cityManifestPath, fixture.manifest.city).length).toBeGreaterThan(0);

    const resized = fixture.entries.map((entry) =>
      entry.sitePath === 'data/city-tiles/0_0.json' ? { ...entry, bytes: entry.bytes + 1 } : entry,
    );
    expect(codes(validateCityPayload(resized, fixture.cityManifestPath, fixture.manifest.city))).toContain('city-tile-bytes-mismatch');

    const outOfRange = writeFile(fixture.root, 'data/city-tiles/1_0.json', '{"buildings":[]}');
    const unexpected = [
      ...fixture.entries,
      { sitePath: 'data/city-tiles/1_0.json', sourcePath: outOfRange, bytes: statSync(outOfRange).size },
    ];
    expect(codes(validateCityPayload(unexpected, fixture.cityManifestPath, fixture.manifest.city))).toContain('city-tile-unexpected');
  });

  it('fails closed when a third-party redistribution right is not evidenced', () => {
    const fixture = buildFixtureSite();
    const inventoryPath = path.join(fixture.root, 'asset-licenses.json');
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as {
      entries: Record<string, unknown>[];
    };
    inventory.entries.push({
      id: 'unverified-exhibit',
      name: 'Exhibit with unknown rights',
      kind: '3d-model',
      thirdParty: true,
      artifactPaths: ['data/museum/exhibits.bin'],
      license: null,
      source: null,
      redistribution: null,
      modified: false,
      attribution: null,
      status: 'owner_required',
      reason: 'upstream permission not evidenced in the repository',
    });
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    const entries = walkFiles(fixture.root);
    const manifest = createArtifactManifest(entries, { cityManifestPath: fixture.cityManifestPath, commitSha: 'fixture-commit' });
    const audit = auditArtifact({ repoRoot: ROOT, entries, manifest });
    expect(audit.ok).toBe(false);
    expect(audit.legal.status).toBe('fail');
    expect(codes(audit.errors)).toContain('third-party-redistribution-owner-required');
  });

  it('rejects a stale or tampered site-manifest.json', () => {
    const stored = JSON.parse(JSON.stringify(fixture.manifest)) as ArtifactManifest;
    stored.files = stored.files.slice(1);
    expect(manifestMismatch(stored, fixture.manifest).length).toBeGreaterThan(0);

    const tampered = JSON.parse(JSON.stringify(fixture.manifest)) as ArtifactManifest;
    tampered.files[0].sha256 = '0'.repeat(64);
    expect(codes(manifestMismatch(tampered, fixture.manifest))).toContain('stored-manifest-file-mismatch');
  });

  it('detects a secret added to the artifact after assembly', () => {
    const root = makeTempRoot('audit-secret');
    writeFile(root, 'index.html', '<div id="root"></div>');
    writeFile(root, 'assets/app.js', 'OpenStreetMap ODbL 1.0');
    writeFile(root, 'assets/leak.js', `const token = "ghp_${'b'.repeat(36)}";`);
    const entries = walkFiles(root);
    expect(codes(scanForbiddenContent(entries))).toContain('github-token');
  });
});

describe('nested-path static server', () => {
  it('serves the artifact below /VoxelMinsk/ and 404s root paths', async () => {
    const fixture = buildFixtureSite();
    const server = await startNestedStaticServer({ siteRoot: fixture.root });
    try {
      expect(server.baseUrl.endsWith('/VoxelMinsk/')).toBe(true);

      const index = await fetch(server.baseUrl);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toContain('text/html');
      expect(await index.text()).toContain('id="root"');

      const manifest = await fetch(`${server.baseUrl}data/city-tiles/manifest.json`);
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get('content-type')).toContain('application/json');
      expect((await manifest.json()).tiles).toHaveLength(1);

      const exhibits = await fetch(`${server.baseUrl}data/museum/exhibits.bin`);
      expect(exhibits.status).toBe(200);
      expect((await exhibits.arrayBuffer()).byteLength).toBe(4);

      expect((await fetch(`${server.origin}/data/city-tiles/manifest.json`)).status).toBe(404);
      expect((await fetch(`${server.baseUrl}data/tiles/manifest.json`)).status).toBe(404);
      const traversal = await fetch(`${server.baseUrl}%2e%2e/package.json`);
      expect([403, 404]).toContain(traversal.status);
    } finally {
      await server.close();
    }
  });
});
