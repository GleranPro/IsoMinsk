#!/usr/bin/env node
/**
 * Assemble the GitHub Pages artifact from an explicit whitelist.
 *
 *   node scripts/qa/build-pages.mjs \
 *     --dist dist --site .pages --city-dir public/data/city-tiles
 *
 * Input:
 *   - the built Vite application (`dist/index.html`, `dist/assets/**`), minus
 *     anything Vite copied from `public/data` (the whitelist below owns it);
 *   - exactly these additions: the accepted complete city payload, the curated
 *     museum payload, `.nojekyll`, `asset-licenses.json`, `data/ATTRIBUTION.md`
 *     and `data/LICENSE-ODbL.txt`.
 *
 * It never copies all of `public/`, never copies `public/data/tiles` or a
 * staging city, and refuses to run if the artifact would contain forbidden
 * directories or secret-like files. The generated `site-manifest.json` is
 * path-sorted and records sizes, SHA-256 digests, the commit SHA and the
 * accepted city manifest hash.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_SITE_DIR_NAME,
  PublicationError,
  SITE_MANIFEST_NAME,
  auditArtifact,
  createArtifactManifest,
  describePathSafety,
  formatArtifactManifest,
  planArtifact,
  repoRelative,
  scanForbiddenContent,
  validateArtifactPaths,
  walkFiles,
} from '../../src/qa/publication.ts';

const USAGE = `Usage: node scripts/qa/build-pages.mjs [options]

Options:
  --dist <dir>       built Vite application (default: dist)
  --site <dir>       output artifact directory; must be exactly .pages (default: .pages)
  --city-dir <dir>   accepted complete-city payload (default: public/data/city-tiles)
  --help             show this help

The command must run from the repository root. It fails closed on missing
inputs, forbidden artifact paths, secret-like files or an unexpected payload.`;

function parseArgs(argv) {
  const args = { dist: 'dist', site: DEFAULT_SITE_DIR_NAME, cityDir: join('public', 'data', 'city-tiles') };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    const match = /^--(dist|site|city-dir)(?:=(.*))?$/.exec(argument);
    if (!match) throw new PublicationError(`unknown argument: ${argument}\n\n${USAGE}`);
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--')) throw new PublicationError(`--${match[1]} needs a value\n\n${USAGE}`);
    if (match[1] === 'dist') args.dist = value;
    if (match[1] === 'site') args.site = value;
    if (match[1] === 'city-dir') args.cityDir = value;
  }
  return args;
}

function assertRepository(repoRoot) {
  const packagePath = join(repoRoot, 'package.json');
  if (!existsSync(packagePath)) throw new PublicationError(`run from the repository root: ${packagePath} is missing`);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new PublicationError(`package.json is not valid JSON: ${error.message}`);
  }
  if (pkg.name !== 'isometric-minsk') throw new PublicationError(`refusing to build in a different project (${pkg.name ?? 'unnamed'})`);
  if (!existsSync(join(repoRoot, 'vite.config.ts'))) throw new PublicationError('vite.config.ts is missing - wrong repository root?');
}

function resolveSiteDir(repoRoot, requested) {
  const site = resolve(repoRoot, requested);
  const relativeSite = repoRelative(repoRoot, site);
  if (relativeSite !== DEFAULT_SITE_DIR_NAME) {
    throw new PublicationError(
      `--site must resolve to exactly "${DEFAULT_SITE_DIR_NAME}" inside the repository (got ${relativeSite}); ` +
        'refusing to delete any other directory',
    );
  }
  if (describePathSafety(repoRoot, site) !== 'inside-repository') {
    throw new PublicationError(`--site must stay inside the repository: ${site}`);
  }
  return site;
}

function prepareSiteDir(site) {
  if (existsSync(site)) {
    const stats = lstatSync(site);
    if (stats.isSymbolicLink()) throw new PublicationError(`refusing to replace a symlinked ${site}`);
    if (!stats.isDirectory()) throw new PublicationError(`${site} exists and is not a directory`);
    if (existsSync(join(site, '.git'))) throw new PublicationError(`refusing to delete ${site}: it contains a .git directory`);
    if (existsSync(join(site, 'package.json'))) throw new PublicationError(`refusing to delete ${site}: it looks like a project checkout`);
    rmSync(site, { recursive: true, force: true });
  }
  mkdirSync(site, { recursive: true });
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
    console.warn('warning: could not resolve the git commit SHA; site-manifest.json commitSha will be null');
    return null;
  }
}

function warnIfDistLooksStale(repoRoot, distDir) {
  const entry = join(distDir, 'index.html');
  if (!existsSync(entry)) return;
  const builtAt = statSync(entry).mtimeMs;
  for (const source of ['src', 'vite.config.ts', 'package.json']) {
    const candidate = join(repoRoot, source);
    if (!existsSync(candidate)) continue;
    const updatedAt = statSync(candidate).mtimeMs;
    if (updatedAt > builtAt + 1000) {
      console.warn(`warning: ${source} is newer than ${repoRelative(repoRoot, entry)} - rebuild before publishing`);
      return;
    }
  }
}

function copyWhitelisted(entries, site) {
  for (const entry of entries) {
    const destination = join(site, ...entry.sitePath.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(entry.sourcePath, destination);
    const copied = statSync(destination).size;
    if (copied !== entry.bytes) {
      throw new PublicationError(`copy changed size for ${entry.sitePath} (${entry.bytes} -> ${copied} bytes)`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  assertRepository(repoRoot);
  const site = resolveSiteDir(repoRoot, args.site);
  const distDir = resolve(repoRoot, args.dist);
  const cityDir = resolve(repoRoot, args.cityDir);
  if (!existsSync(distDir)) {
    throw new PublicationError(`dist directory not found: ${distDir} (run "pnpm run build" first)`);
  }
  warnIfDistLooksStale(repoRoot, distDir);

  const entries = planArtifact({ repoRoot, distDir, cityDir });
  const plannedProblems = [...validateArtifactPaths(entries), ...scanForbiddenContent(entries)];
  if (plannedProblems.length > 0) {
    for (const problem of plannedProblems) console.error(`error: [${problem.code}] ${problem.path ?? ''} ${problem.message}`);
    throw new PublicationError(`refusing to assemble an artifact with ${plannedProblems.length} forbidden input(s)`);
  }

  prepareSiteDir(site);
  copyWhitelisted(entries, site);

  const siteEntries = walkFiles(site);
  const plannedPaths = entries.map((entry) => entry.sitePath).join('\u0000');
  const copiedPaths = siteEntries.map((entry) => entry.sitePath).join('\u0000');
  if (siteEntries.length !== entries.length || plannedPaths !== copiedPaths) {
    throw new PublicationError('assembled file list does not match the whitelist');
  }

  const commitSha = resolveCommitSha(repoRoot);
  const cityManifestPath = join(site, 'data', 'city-tiles', 'manifest.json');
  const manifest = createArtifactManifest(siteEntries, { cityManifestPath, commitSha });
  const manifestPath = join(site, SITE_MANIFEST_NAME);
  writeFileSync(manifestPath, formatArtifactManifest(manifest), 'utf8');

  const audit = auditArtifact({ repoRoot, entries: siteEntries, manifest, requireAppBundle: true });
  for (const warning of audit.warnings) console.warn(`warning: [${warning.code}] ${warning.message}`);
  for (const problem of audit.errors) console.error(`error: [${problem.code}] ${problem.path ?? ''} ${problem.message}`);

  const cityManifest = JSON.parse(readFileSync(cityManifestPath, 'utf8'));
  const cityVersion = cityManifest.version ?? 'unknown';
  console.log(`site:      ${repoRelative(repoRoot, site)}`);
  console.log(`dist:      ${repoRelative(repoRoot, distDir)}`);
  console.log(`city:      ${repoRelative(repoRoot, cityDir)} (version ${cityVersion}, ${manifest.counts.cityTiles} tiles, ${manifest.city.tileBytes} bytes)`);
  console.log(`files:     ${manifest.counts.files} (city tile files ${manifest.counts.cityTileFiles}, museum files ${manifest.counts.museumFiles}, corridor mobility files ${manifest.counts.mobilityFiles}, city mobility files ${manifest.counts.mobilityCityFiles})`);
  console.log(`total:     ${manifest.totalBytes} bytes (warning ${manifest.warning}, fatal ${manifest.fatalError})`);
  console.log(`commit:    ${manifest.commitSha ?? 'unknown'}`);
  console.log(`city hash: ${manifest.city.manifestSha256}`);
  console.log(`manifest:  ${repoRelative(repoRoot, manifestPath)}`);
  console.log(`audit:     ${audit.ok ? 'pass' : 'FAIL'} (${audit.errors.length} errors, ${audit.warnings.length} warnings)`);
  if (!audit.ok) {
    console.error('artifact written for inspection but the publication gate FAILED; do not deploy it.');
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  if (error instanceof PublicationError) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
