#!/usr/bin/env node
/**
 * Audit the assembled GitHub Pages artifact.
 *
 *   node scripts/qa/publication-audit.mjs --site .pages [--static-only]
 *
 * 1. Checks the artifact contents fail-closed (`src/qa/publication.ts`): one
 *    complete city, no alternate/reduced dataset, no raw/interim/worktree/
 *    backup files, no secret-like files, OSM/ODbL notices, complete licence
 *    inventory and a site-manifest.json that still matches every digest.
 * 2. Without `--static-only`, mounts the artifact below `/VoxelMinsk/` with a
 *    minimal static server that preserves MIME types and verifies the index,
 *    the city manifest, the first tile, the museum payload, the attribution and
 *    licence files, and that root/legacy dataset paths are NOT served.
 *
 * Results are recorded compactly in `publication-report.json` (committable:
 * counts, bytes, hashes, requested routes/statuses and the legal audit status).
 * The full per-file manifest lives in `.pages/site-manifest.json`, which stays
 * git-ignored.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  DEFAULT_NESTED_BASE,
  PublicationError,
  SITE_MANIFEST_NAME,
  auditArtifact,
  createArtifactManifest,
  describePathSafety,
  manifestMismatch,
  repoRelative,
  startNestedStaticServer,
  walkFiles,
} from '../../src/qa/publication.ts';

const USAGE = `Usage: node scripts/qa/publication-audit.mjs [options]

Options:
  --site <dir>     assembled artifact directory (default: .pages)
  --static-only    content audit only; do not serve the artifact
  --report <file>  report path inside the repository (default: publication-report.json)
  --port <number>  port for the nested-path server (default: ephemeral)
  --help           show this help`;

function parseArgs(argv) {
  const args = { site: '.pages', staticOnly: false, report: 'publication-report.json', port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (argument === '--static-only') {
      args.staticOnly = true;
      continue;
    }
    const match = /^--(site|report|port)(?:=(.*))?$/.exec(argument);
    if (!match) throw new PublicationError(`unknown argument: ${argument}\n\n${USAGE}`);
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--')) throw new PublicationError(`--${match[1]} needs a value\n\n${USAGE}`);
    if (match[1] === 'site') args.site = value;
    if (match[1] === 'report') args.report = value;
    if (match[1] === 'port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PublicationError(`invalid --port: ${value}`);
      args.port = port;
    }
  }
  return args;
}

function resolveCommitSha(repoRoot) {
  const fromEnvironment = process.env.GITHUB_SHA;
  if (fromEnvironment && /^[0-9a-f]{7,40}$/i.test(fromEnvironment)) return fromEnvironment;
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} repoRoot
 * @param {{site: string, staticOnly: boolean, report: string, port: number}} args
 */
async function main(repoRoot, args) {
  const site = resolve(repoRoot, args.site);
  if (!existsSync(site)) throw new PublicationError(`artifact site not found: ${site} (run scripts/qa/build-pages.mjs first)`);
  if (describePathSafety(repoRoot, site) !== 'inside-repository') {
    throw new PublicationError(`--site must be inside the repository: ${site}`);
  }
  const reportPath = resolve(repoRoot, args.report);
  if (describePathSafety(repoRoot, reportPath) !== 'inside-repository') {
    throw new PublicationError(`--report must be inside the repository: ${reportPath}`);
  }

  const failures = [];
  const warnings = [];
  const checks = [];
  const requests = [];
  const generatedAt = new Date().toISOString();
  const commitSha = resolveCommitSha(repoRoot);
  const fail = (message) => failures.push(message);

  const allEntries = walkFiles(site);
  const entries = allEntries.filter((entry) => entry.sitePath !== SITE_MANIFEST_NAME);
  if (entries.length === 0) {
    throw new PublicationError(`artifact site is empty: ${site}`);
  }
  const cityManifestEntry = entries.find((entry) => entry.sitePath === 'data/city-tiles/manifest.json');
  if (!cityManifestEntry) {
    const report = {
      schemaVersion: 1,
      generatedAt,
      commitSha,
      mode: args.staticOnly ? 'static' : 'served',
      site: repoRelative(repoRoot, site),
      artifactBase: DEFAULT_NESTED_BASE,
      failures: ['data/city-tiles/manifest.json is missing: the artifact is not a complete city release'],
      requestedAt: null,
      requests: [],
      checks: [],
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`, 'utf8');
    throw new PublicationError(report.failures[0]);
  }

  const manifest = createArtifactManifest(entries, { cityManifestPath: cityManifestEntry.sourcePath, commitSha });
  const audit = auditArtifact({ repoRoot, entries, manifest, requireAppBundle: true });
  for (const problem of audit.errors) fail(`[${problem.code}] ${problem.path ?? ''} ${problem.message}`);
  for (const warning of audit.warnings) warnings.push(`[${warning.code}] ${warning.message}`);
  checks.push({
    id: 'artifact-contents',
    status: audit.errors.length === 0 ? 'pass' : 'fail',
    detail: `${manifest.files.length} files, ${manifest.totalBytes} bytes, ${manifest.counts.cityTiles} city tiles`,
  });

  const storedManifestPath = join(site, SITE_MANIFEST_NAME);
  let storedManifestStatus = 'missing';
  if (existsSync(storedManifestPath)) {
    try {
      const stored = JSON.parse(readFileSync(storedManifestPath, 'utf8'));
      const mismatches = manifestMismatch(stored, manifest);
      storedManifestStatus = mismatches.length === 0 ? 'pass' : 'fail';
      for (const problem of mismatches) fail(`[${problem.code}] ${problem.path ?? ''} ${problem.message}`);
    } catch (error) {
      storedManifestStatus = 'fail';
      fail(`site-manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    fail('site-manifest.json is missing: build the artifact with scripts/qa/build-pages.mjs');
  }
  checks.push({ id: 'stored-manifest', status: storedManifestStatus, detail: storedManifestStatus });

  /** @type {import('../../src/qa/publication.ts').NestedStaticServer | null} */
  let server = null;
  let firstTile = null;
  let museumManifest = null;

  const record = (route, status, bytes, contentType) => {
    requests.push({ route, status, bytes, contentType });
  };

  const get = async (id, route, options = {}) => {
    const { expect = 200, allow = [], validate = null, scope = 'nested' } = options;
    const url = route.startsWith('http') ? route : scope === 'root' ? `${server.origin}/${route}` : `${server.baseUrl}${route}`;
    const display = scope === 'root' ? `/${route}` : `${DEFAULT_NESTED_BASE}${route}`;
    let response;
    let buffer;
    try {
      response = await fetch(url, { redirect: 'manual' });
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      record(display, 0, 0, null);
      fail(`[${id}] request failed: ${error instanceof Error ? error.message : String(error)}`);
      checks.push({ id, status: 'fail', detail: 'request failed' });
      return null;
    }
    const allowed = [expect, ...allow];
    record(display, response.status, buffer.byteLength, response.headers.get('content-type'));
    if (!allowed.includes(response.status)) {
      fail(`[${id}] ${display} returned HTTP ${response.status} (expected ${allowed.join('/')})`);
      checks.push({ id, status: 'fail', detail: `HTTP ${response.status}` });
      return null;
    }
    if (validate) {
      try {
        await validate(buffer, response);
      } catch (error) {
        fail(`[${id}] ${display}: ${error instanceof Error ? error.message : String(error)}`);
        checks.push({ id, status: 'fail', detail: error instanceof Error ? error.message : String(error) });
        return null;
      }
    }
    checks.push({ id, status: 'pass', detail: `${response.status}, ${buffer.byteLength} bytes` });
    return { response, buffer };
  };

  try {
    if (!args.staticOnly) {
      server = await startNestedStaticServer({ siteRoot: site, basePath: DEFAULT_NESTED_BASE, port: args.port });

      const index = await get('index', '', {
        validate: (buffer) => {
          const html = buffer.toString('utf8');
          if (!html.includes('id="root"')) throw new Error('index.html does not contain the application root element');
          const sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
          if (sources.length === 0) throw new Error('index.html has no module script');
          const absolute = sources.filter((source) => source.startsWith('/'));
          if (absolute.length > 0) throw new Error(`absolute script URL breaks project-path hosting: ${absolute.join(', ')}`);
          return sources[0];
        },
      });
      let appScript = null;
      if (index) {
        const html = index.buffer.toString('utf8');
        const sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
        appScript = sources[0]?.replace(/^\.\//, '') ?? null;
      }
      if (appScript) {
        await get('app-bundle', appScript, {
          validate: (buffer) => {
            if (buffer.byteLength === 0) throw new Error('application bundle is empty');
          },
        });
      } else {
        fail('[app-bundle] index.html does not reference a module script');
        checks.push({ id: 'app-bundle', status: 'fail', detail: 'no script source in index.html' });
      }

      const cityManifestResponse = await get('city-manifest', 'data/city-tiles/manifest.json', {
        validate: (buffer) => {
          const parsed = JSON.parse(buffer.toString('utf8'));
          if (!Array.isArray(parsed.tiles) || parsed.tiles.length === 0) throw new Error('city manifest has no tiles');
          if (parsed.tiles.length !== manifest.city.tileCount) {
            throw new Error(`city manifest lists ${parsed.tiles.length} tiles, site-manifest records ${manifest.city.tileCount}`);
          }
        },
      });
      if (cityManifestResponse) {
        const city = JSON.parse(cityManifestResponse.buffer.toString('utf8'));
        firstTile = city.tiles[0];
        if (!firstTile || typeof firstTile.file !== 'string') fail('[first-tile] city manifest has no usable first tile entry');
      }
      if (firstTile) {
        const name = firstTile.file.split('/').pop();
        await get('first-tile', `data/city-tiles/${name}`, {
          validate: (buffer) => {
            const tile = JSON.parse(buffer.toString('utf8'));
            if (tile.tileX !== firstTile.x || tile.tileY !== firstTile.y) throw new Error('tile payload coordinates do not match the manifest');
            if (!Array.isArray(tile.buildings)) throw new Error('tile payload has no buildings array (HTML fallback?)');
            if (buffer.byteLength !== firstTile.bytes) throw new Error(`tile is ${buffer.byteLength} bytes, manifest says ${firstTile.bytes}`);
          },
        });
      }

      await get('museum-manifest', 'data/museum/manifest.json', {
        validate: (buffer) => {
          museumManifest = JSON.parse(buffer.toString('utf8'));
          if (typeof museumManifest.byteLength !== 'number' || museumManifest.byteLength <= 0) {
            throw new Error('museum manifest has no byteLength');
          }
          if (!Array.isArray(museumManifest.exhibits)) throw new Error('museum manifest has no exhibits array');
        },
      });
      await get('museum-exhibits', 'data/museum/exhibits.bin', {
        validate: (buffer) => {
          if (museumManifest && buffer.byteLength !== museumManifest.byteLength) {
            throw new Error(`exhibits.bin is ${buffer.byteLength} bytes, manifest says ${museumManifest.byteLength}`);
          }
        },
      });

      await get('attribution', 'data/ATTRIBUTION.md', {
        validate: (buffer) => {
          const text = buffer.toString('utf8');
          if (!text.includes('OpenStreetMap')) throw new Error('attribution does not name OpenStreetMap');
          if (!/ODbL 1\.0/i.test(text)) throw new Error('attribution does not state ODbL 1.0');
        },
      });
      await get('odbl-licence', 'data/LICENSE-ODbL.txt', {
        validate: (buffer) => {
          const text = buffer.toString('utf8');
          if (!/Open Database License/i.test(text) || !text.includes('Open Data Commons')) {
            throw new Error('LICENSE-ODbL.txt is not the ODbL text');
          }
        },
      });
      await get('licence-inventory', 'asset-licenses.json', {
        validate: (buffer) => {
          const inventory = JSON.parse(buffer.toString('utf8'));
          if (!Array.isArray(inventory.entries) || inventory.entries.length === 0) throw new Error('asset-licenses.json has no entries');
        },
      });
      await get('site-manifest', SITE_MANIFEST_NAME, {
        validate: (buffer) => {
          const parsed = JSON.parse(buffer.toString('utf8'));
          if (parsed.schemaVersion !== 1) throw new Error('site-manifest.json has an unsupported schemaVersion');
        },
      });

      // Legacy/alternate datasets must never be reachable, not even below the prefix.
      for (const legacyPath of ['data/tiles/manifest.json', 'data/city-tiles-current/manifest.json', 'data/city-tiles-b2/manifest.json']) {
        await get(`legacy-absent:${legacyPath}`, legacyPath, { expect: 404, allow: [403] });
      }
      await get('root-absent', 'data/city-tiles/manifest.json', { expect: 404, allow: [403], scope: 'root' });
    } else {
      checks.push({ id: 'nested-path-serving', status: 'skip', detail: '--static-only requested' });
    }

    const legal = {
      status: audit.legal.status,
      ownerRequired: audit.legal.ownerRequired,
      thirdPartyAssets: audit.legal.thirdPartyAssets,
    };
    const report = {
      schemaVersion: 1,
      generatedAt,
      commitSha,
      mode: args.staticOnly ? 'static' : 'served',
      site: repoRelative(repoRoot, site),
      artifactBase: DEFAULT_NESTED_BASE,
      artifact: {
        files: manifest.files.length,
        totalBytes: manifest.totalBytes,
        warningThresholdBytes: manifest.warningThresholdBytes,
        warning: manifest.warning,
        fatalError: manifest.fatalError,
      },
      city: {
        version: manifest.city.version,
        tileCount: manifest.city.tileCount,
        tileBytes: manifest.city.tileBytes,
        manifestSha256: manifest.city.manifestSha256,
        buildings: manifest.city.counts.buildings ?? null,
        trees: manifest.city.counts.trees ?? null,
      },
      legal,
      storedManifest: storedManifestStatus,
      checks,
      requests,
      warnings,
      failures,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`, 'utf8');

    console.log(`site:      ${report.site}`);
    console.log(`mode:      ${report.mode}`);
    console.log(`files:     ${manifest.files.length} (city tiles ${manifest.counts.cityTiles}, museum files ${manifest.counts.museumFiles})`);
    console.log(`total:     ${manifest.totalBytes} bytes (warning ${manifest.warning}, fatal ${manifest.fatalError})`);
    console.log(`city:      version ${manifest.city.version ?? 'unknown'}, ${manifest.city.tileCount} tiles, hash ${manifest.city.manifestSha256}`);
    console.log(`legal:     ${legal.status}${legal.ownerRequired.length ? ` (owner required: ${legal.ownerRequired.join(', ')})` : ''}`);
    console.log(`requests:  ${requests.length}`);
    for (const warning of warnings) console.warn(`warning: ${warning}`);
    if (failures.length > 0) {
      for (const message of failures) console.error(`failure: ${message}`);
      console.log(`report:    ${repoRelative(repoRoot, reportPath)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`report:    ${repoRelative(repoRoot, reportPath)}`);
    console.log('publication audit: PASS');
  } finally {
    if (server) await server.close();
  }
}

try {
  const repoRoot = process.cwd();
  if (!existsSync(join(repoRoot, 'package.json'))) throw new PublicationError(`run from the repository root: ${join(repoRoot, 'package.json')} is missing`);
  await main(repoRoot, parseArgs(process.argv.slice(2)));
} catch (error) {
  if (error instanceof PublicationError) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
