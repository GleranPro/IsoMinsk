/**
 * Publication artifact contract and licence gate (Tasks 10-11).
 *
 * Node-only module shared by:
 *   - `scripts/qa/build-pages.mjs` (whitelist assembler, writes site-manifest.json)
 *   - `scripts/qa/publication-audit.mjs` (content + nested-path release audit)
 *   - `tests/unit/publication.test.ts` and `tests/e2e/publication.spec.ts`
 *
 * It must never be imported by browser code: it uses `node:fs`, `node:crypto`
 * and `node:http`. The static artifact is assembled from an explicit whitelist;
 * nothing is copied because it happens to live under `public/`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { basename, extname, join, posix, relative, resolve, sep } from 'node:path';

/** 500 MiB: warns only; it never deletes tiles. */
export const WARNING_THRESHOLD_BYTES = 500 * 2 ** 20;
/** 900 MB (decimal): the only fatal artifact-size error. */
export const FATAL_TOTAL_BYTES = 900_000_000;
export const SITE_MANIFEST_NAME = 'site-manifest.json';
export const DEFAULT_NESTED_BASE = '/VoxelMinsk/';
export const DEFAULT_SITE_DIR_NAME = '.pages';

/** Files that must exist in every publishable artifact. */
export const REQUIRED_ARTIFACT_PATHS: readonly string[] = [
  'index.html',
  '.nojekyll',
  'asset-licenses.json',
  'data/ATTRIBUTION.md',
  'data/LICENSE-ODbL.txt',
  'data/city-tiles/manifest.json',
  'data/museum/manifest.json',
  'data/museum/exhibits.bin',
];

/** Directory names that must never appear inside a published artifact. */
const FORBIDDEN_SEGMENTS = new Set([
  'screenshots',
  'test-results',
  'playwright-report',
  'node_modules',
  'credentials',
  'secrets',
  '.git',
  '.svn',
  '.hg',
  '.worktrees',
  '.agents',
  '.pages',
  '.venv',
  '.ssh',
]);

const FORBIDDEN_EXTENSIONS = new Set([
  '.pbf',
  '.osm',
  '.shp',
  '.shx',
  '.dbf',
  '.gpkg',
  '.geojson',
  '.mbtiles',
  '.blend',
  '.psd',
  '.fbx',
  '.glb',
  '.gltf',
  '.obj',
  '.zip',
  '.7z',
  '.rar',
  '.sqlite',
  '.db',
  '.log',
  '.swp',
  '.swo',
]);

const BACKUP_SUFFIX = /(?:~|\.(?:bak|backup|orig|rej|tmp|old))$/i;
const SECRET_FILE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\..*)?|secrets(?:\..*)?)$/i;
const SECRET_EXTENSION = /\.(?:pem|key|pfx|p12|keystore|jks)$/i;

const TEXT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.md',
  '.txt',
  '.map',
  '.svg',
  '.xml',
  '.yml',
  '.yaml',
  '.glsl',
  '.frag',
  '.vert',
  '.csv',
]);
const TEXT_NAMES = new Set(['.nojekyll', 'license', 'notice', 'cname', 'robots.txt']);

interface SecretPattern {
  code: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    code: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  {
    code: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  },
  { code: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { code: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  {
    code: 'secret-assignment',
    pattern:
      /(?:api[_-]?key|apikey|secret|password|passwd|client[_-]?secret|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'`][^"'`\s]{12,}["'`]/i,
  },
];

export class PublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationError';
  }
}

export interface ArtifactEntry {
  /** Path inside the published artifact, always POSIX separators. */
  sitePath: string;
  /** Absolute path the bytes are read from (source tree or assembled site). */
  sourcePath: string;
  bytes: number;
}

export interface ArtifactFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface CityTileRange {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CitySummary {
  version: string | null;
  tileCount: number;
  tileBytes: number;
  manifestSha256: string;
  tileRange: CityTileRange | null;
  counts: Record<string, number>;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  generator: string;
  commitSha: string | null;
  city: CitySummary;
  files: ArtifactFile[];
  directories: string[];
  totalBytes: number;
  warningThresholdBytes: number;
  warning: boolean;
  fatalError: boolean;
  counts: {
    files: number;
    cityTileFiles: number;
    cityTiles: number;
    museumFiles: number;
  };
}

export interface Problem {
  code: string;
  message: string;
  path?: string;
}

export interface LicenseText {
  package: string;
  copyright: string;
  text: string;
}

export interface AssetLicenseEntry {
  id: string;
  name: string;
  kind: string;
  thirdParty: boolean;
  exhibitSlug?: string;
  artifactPaths: string[];
  sourcePaths?: string[];
  /** True when the asset exists in the source repository but is not shipped in the artifact. */
  sourceOnly?: boolean;
  license: string | null;
  licenseUrl?: string | null;
  licenseId?: string | null;
  source: string | null;
  author?: string | null;
  redistribution: boolean | null;
  modified: boolean;
  modificationNote?: string;
  attribution: string | null;
  status: 'verified' | 'owner_required';
  reason?: string;
  licenseTexts?: LicenseText[];
}

export interface CodeLicense {
  name: string;
  paths: string[];
  license: string | null;
  licenseUrl: string | null;
  source: string | null;
  redistribution: boolean | null;
  modified: boolean;
  attribution: string | null;
  status: 'verified' | 'owner_required';
  ownerDecision: string | null;
}

export interface AssetLicensesFile {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  note?: string;
  code: CodeLicense;
  entries: AssetLicenseEntry[];
}

export interface LegalAudit {
  status: 'pass' | 'pass_with_owner_required' | 'fail';
  ownerRequired: string[];
  thirdPartyAssets: number;
  errors: Problem[];
  warnings: Problem[];
}

export interface ArtifactAudit {
  ok: boolean;
  errors: Problem[];
  warnings: Problem[];
  legal: LegalAudit;
  required: { path: string; present: boolean }[];
  city: {
    version: string | null;
    expectedTiles: number;
    presentTiles: number;
    tileBytes: number;
    manifestSha256: string;
  };
}

export interface NestedStaticServer {
  origin: string;
  baseUrl: string;
  server: Server;
  close: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

function isStrictlyInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild !== normalizedParent && normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

export function classifyArtifactSize(totalBytes: number): { warning: boolean; fatalError: boolean } {
  return {
    warning: totalBytes >= WARNING_THRESHOLD_BYTES,
    fatalError: totalBytes >= FATAL_TOTAL_BYTES,
  };
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sortBySitePath(entries: ArtifactEntry[]): ArtifactEntry[] {
  return [...entries].sort((a, b) => (a.sitePath < b.sitePath ? -1 : a.sitePath > b.sitePath ? 1 : 0));
}

function requireDirectory(absolutePath: string, label: string): string {
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    throw new PublicationError(`${label} does not exist: ${absolutePath}`);
  }
  if (!stats.isDirectory()) throw new PublicationError(`${label} is not a directory: ${absolutePath}`);
  return absolutePath;
}

function requireFile(absolutePath: string, label: string): string {
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    throw new PublicationError(`${label} does not exist: ${absolutePath}`);
  }
  if (!stats.isFile()) throw new PublicationError(`${label} is not a file: ${absolutePath}`);
  return absolutePath;
}

/** Resolves a CLI-supplied path and refuses anything outside `repoRoot`. */
export function resolveRepoPath(repoRoot: string, candidate: string, label: string): string {
  const root = resolve(repoRoot);
  const target = resolve(root, candidate);
  if (!isInside(root, target)) throw new PublicationError(`${label} must resolve inside the repository (${root}): ${target}`);
  return target;
}

/**
 * Absolute file listing below `root` as path-sorted artifact entries.
 * Symlinks are refused: the artifact must be self-contained, not a link graph.
 */
export function walkFiles(root: string, options: { exclude?: (relativePath: string) => boolean } = {}): ArtifactEntry[] {
  const rootPath = requireDirectory(resolve(root), 'artifact root');
  const entries: ArtifactEntry[] = [];
  const visit = (directory: string, prefix: string): void => {
    const children = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      if (options.exclude?.(relativePath)) continue;
      const absolutePath = join(directory, child.name);
      if (child.isSymbolicLink()) throw new PublicationError(`symlinks are not allowed in the artifact input: ${relativePath}`);
      if (child.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!child.isFile()) continue;
      entries.push({ sitePath: relativePath, sourcePath: absolutePath, bytes: statSync(absolutePath).size });
    }
  };
  visit(rootPath, '');
  return sortBySitePath(entries);
}

function withSitePrefix(entries: ArtifactEntry[], prefix: string): ArtifactEntry[] {
  return entries.map((entry) => ({ ...entry, sitePath: `${prefix}/${entry.sitePath}` }));
}

function collectDirectories(entries: ArtifactEntry[]): string[] {
  const directories = new Set<string>();
  for (const entry of entries) {
    const segments = entry.sitePath.split('/');
    for (let index = 1; index < segments.length; index += 1) directories.add(segments.slice(0, index).join('/'));
  }
  return [...directories].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const PUBLIC_DATA_WHITELIST = ['data/city-tiles/', 'data/museum/'];

function checkDataPath(sitePath: string): Problem | null {
  if (sitePath === 'data' || sitePath.startsWith('data/')) {
    const allowed =
      (sitePath === 'data/ATTRIBUTION.md' || sitePath === 'data/LICENSE-ODbL.txt') ||
      PUBLIC_DATA_WHITELIST.some((prefix) => sitePath.startsWith(prefix));
    if (!allowed) {
      return {
        code: 'forbidden-artifact-path',
        path: sitePath,
        message: 'only data/city-tiles, data/museum, data/ATTRIBUTION.md and data/LICENSE-ODbL.txt may be published',
      };
    }
  }
  return null;
}

/** Path-only policy: forbidden datasets, raw/interim/worktree/backup and credential files. */
export function validateArtifactPaths(entries: ArtifactEntry[]): Problem[] {
  const problems: Problem[] = [];
  for (const entry of entries) {
    const sitePath = entry.sitePath;
    const fail = (code: string, message: string): void => {
      problems.push({ code, path: sitePath, message });
    };
    if (!sitePath || sitePath !== sitePath.trim()) {
      fail('invalid-artifact-path', 'artifact paths must be non-empty and contain no surrounding whitespace');
      continue;
    }
    if (sitePath.includes('\\') || sitePath.startsWith('/') || /^[A-Za-z]:/.test(sitePath)) {
      fail('invalid-artifact-path', 'artifact paths must be relative POSIX paths');
      continue;
    }
    const segments = sitePath.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      fail('invalid-artifact-path', 'artifact paths may not contain empty, "." or ".." segments');
      continue;
    }
    const dataProblem = checkDataPath(sitePath);
    if (dataProblem) {
      problems.push(dataProblem);
      continue;
    }
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
      fail('forbidden-artifact-path', 'screenshot, worktree, staging, credential or tooling directory must not be published');
      continue;
    }
    const name = segments[segments.length - 1];
    if (BACKUP_SUFFIX.test(name)) {
      fail('backup-file', 'backup/temporary file must not be published');
      continue;
    }
    if (FORBIDDEN_EXTENSIONS.has(extname(name).toLowerCase())) {
      fail('forbidden-file-type', `raw/interim/model/archive file ${extname(name).toLowerCase()} must not be published`);
      continue;
    }
    if (SECRET_FILE_NAME.test(name) || SECRET_EXTENSION.test(name)) {
      fail('secret-file-name', 'credential/key file must not be published');
      continue;
    }
  }
  return problems;
}

function isTextCandidate(entry: ArtifactEntry): boolean {
  const name = basename(entry.sitePath).toLowerCase();
  if (TEXT_NAMES.has(name)) return true;
  const extension = extname(name).toLowerCase();
  // Extensionless files (LICENSE, id_rsa, .nojekyll, CNAME) are scanned as text:
  // a private key usually has no extension and must not slip through.
  if (extension === '') return true;
  return TEXT_EXTENSIONS.has(extension);
}

/** Content scan for credentials that a path check cannot see. */
export function scanForbiddenContent(entries: ArtifactEntry[]): Problem[] {
  const problems: Problem[] = [];
  for (const entry of entries) {
    if (!isTextCandidate(entry)) continue;
    const content = readFileSync(entry.sourcePath, 'utf8');
    for (const { code, pattern } of SECRET_PATTERNS) {
      const match = pattern.exec(content);
      if (!match) continue;
      problems.push({
        code,
        path: entry.sitePath,
        message: `secret-like content detected near "${match[0].slice(0, 24).replace(/\s+/g, ' ')}…"`,
      });
    }
  }
  return problems;
}

function assertJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PublicationError(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function assertJsonArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new PublicationError(`${label} must be a JSON array`);
  return value;
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PublicationError(`${label} must be a finite number`);
  return value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new PublicationError(`${label} must be a non-empty string`);
  return value;
}

interface ParsedCityManifest {
  tiles: { x: number; y: number; file: string; bytes: number }[];
  tileRange: CityTileRange | null;
  counts: Record<string, number>;
  version: string | null;
  attribution: unknown[];
}

function parseCityManifest(manifestPath: string): ParsedCityManifest {
  const doc = assertJsonRecord(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, `city manifest ${manifestPath}`);
  const tiles = assertJsonArray(doc.tiles, 'city manifest.tiles').map((raw, index) => {
    const tile = assertJsonRecord(raw, `city manifest.tiles[${index}]`);
    return {
      x: assertNumber(tile.x, `tiles[${index}].x`),
      y: assertNumber(tile.y, `tiles[${index}].y`),
      file: assertString(tile.file, `tiles[${index}].file`),
      bytes: assertNumber(tile.bytes, `tiles[${index}].bytes`),
    };
  });
  const range = doc.tileRange === undefined || doc.tileRange === null ? null : assertJsonRecord(doc.tileRange, 'city manifest.tileRange');
  const tileRange: CityTileRange | null = range
    ? {
        minX: assertNumber(range.minX, 'tileRange.minX'),
        minY: assertNumber(range.minY, 'tileRange.minY'),
        maxX: assertNumber(range.maxX, 'tileRange.maxX'),
        maxY: assertNumber(range.maxY, 'tileRange.maxY'),
      }
    : null;
  const counts: Record<string, number> = {};
  if (doc.counts !== undefined) {
    for (const [key, value] of Object.entries(assertJsonRecord(doc.counts, 'city manifest.counts'))) {
      if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
    }
  }
  return {
    tiles,
    tileRange,
    counts,
    version: typeof doc.version === 'string' ? doc.version : null,
    attribution: doc.attribution === undefined ? [] : assertJsonArray(doc.attribution, 'city manifest.attribution'),
  };
}

export function readCityManifest(manifestPath: string): CitySummary {
  const parsed = parseCityManifest(manifestPath);
  return {
    version: parsed.version,
    tileCount: parsed.tiles.length,
    tileBytes: parsed.tiles.reduce((sum, tile) => sum + tile.bytes, 0),
    manifestSha256: sha256File(manifestPath),
    tileRange: parsed.tileRange,
    counts: parsed.counts,
  };
}

export interface PlanOptions {
  repoRoot: string;
  cityDir: string;
}

/**
 * The explicit publication whitelist. Nothing else from `public/` is copied.
 * Fails closed when the accepted city payload or the notice files are missing.
 */
export function planWhitelistAdditions(options: PlanOptions): ArtifactEntry[] {
  const repoRoot = resolve(options.repoRoot);
  requireDirectory(repoRoot, 'repository root');
  const cityDir = resolveRepoPath(repoRoot, options.cityDir, 'city directory');
  requireDirectory(cityDir, 'city directory');
  requireFile(join(cityDir, 'manifest.json'), 'city manifest');

  const publicDir = join(repoRoot, 'public');
  requireDirectory(publicDir, 'public directory');
  const files: { relative: string; sitePath: string }[] = [
    { relative: '.nojekyll', sitePath: '.nojekyll' },
    { relative: 'asset-licenses.json', sitePath: 'asset-licenses.json' },
    { relative: join('data', 'ATTRIBUTION.md'), sitePath: 'data/ATTRIBUTION.md' },
    { relative: join('data', 'LICENSE-ODbL.txt'), sitePath: 'data/LICENSE-ODbL.txt' },
  ];
  const entries: ArtifactEntry[] = [];
  for (const file of files) {
    const sourcePath = requireFile(join(publicDir, file.relative), `required publication file public/${toPosix(file.relative)}`);
    entries.push({ sitePath: file.sitePath, sourcePath, bytes: statSync(sourcePath).size });
  }
  // The museum payload must be complete before it is copied; the walk below adds it.
  requireFile(join(publicDir, 'data', 'museum', 'manifest.json'), 'required publication file public/data/museum/manifest.json');
  requireFile(join(publicDir, 'data', 'museum', 'exhibits.bin'), 'required publication file public/data/museum/exhibits.bin');

  const cityEntries = withSitePrefix(walkFiles(cityDir), 'data/city-tiles');
  const museumEntries = withSitePrefix(walkFiles(join(publicDir, 'data', 'museum')), 'data/museum');
  const combined = sortBySitePath([...entries, ...cityEntries, ...museumEntries]);
  const seen = new Set<string>();
  for (const entry of combined) {
    if (seen.has(entry.sitePath)) throw new PublicationError(`duplicate artifact path: ${entry.sitePath}`);
    seen.add(entry.sitePath);
  }
  return combined;
}

/** Built application files, excluding the public data Vite copies into `dist/`. */
export function collectDistEntries(distDir: string): ArtifactEntry[] {
  const resolvedDist = requireDirectory(resolve(distDir), 'dist directory');
  const entries = walkFiles(resolvedDist).filter((entry) => {
    if (entry.sitePath === SITE_MANIFEST_NAME) return false;
    if (entry.sitePath === 'data' || entry.sitePath.startsWith('data/')) return false;
    // These come from public/ and are re-added by the explicit whitelist.
    if (entry.sitePath === '.nojekyll' || entry.sitePath === 'asset-licenses.json') return false;
    return true;
  });
  if (!entries.some((entry) => entry.sitePath === 'index.html')) {
    throw new PublicationError(`dist has no index.html - run "pnpm run build" before assembling the Pages artifact: ${resolvedDist}`);
  }
  if (!entries.some((entry) => /\.(?:js|mjs)$/i.test(entry.sitePath))) {
    throw new PublicationError(`dist has no JavaScript bundle - the build output looks incomplete: ${resolvedDist}`);
  }
  return sortBySitePath(entries);
}

export interface ArtifactPlanOptions extends PlanOptions {
  distDir: string;
}

/** Dist output plus the explicit whitelist; the only input `build-pages.mjs` copies. */
export function planArtifact(options: ArtifactPlanOptions): ArtifactEntry[] {
  const repoRoot = resolve(options.repoRoot);
  const distDir = resolveRepoPath(repoRoot, options.distDir, 'dist directory');
  const additions = planWhitelistAdditions({ repoRoot, cityDir: options.cityDir });
  const distEntries = collectDistEntries(distDir);
  const combined = sortBySitePath([...distEntries, ...additions]);
  const seen = new Set<string>();
  for (const entry of combined) {
    if (seen.has(entry.sitePath)) throw new PublicationError(`duplicate artifact path: ${entry.sitePath}`);
    seen.add(entry.sitePath);
  }
  return combined;
}

export interface ManifestOptions {
  cityManifestPath: string;
  commitSha?: string | null;
  generator?: string;
}

export function createArtifactManifest(entries: ArtifactEntry[], options: ManifestOptions): ArtifactManifest {
  const sortedEntries = sortBySitePath(entries);
  const files: ArtifactFile[] = [];
  let totalBytes = 0;
  for (const entry of sortedEntries) {
    const actualBytes = statSync(entry.sourcePath).size;
    if (actualBytes !== entry.bytes) {
      throw new PublicationError(`artifact input changed while planning: ${entry.sitePath} (${entry.bytes} -> ${actualBytes} bytes)`);
    }
    files.push({ path: entry.sitePath, bytes: entry.bytes, sha256: sha256File(entry.sourcePath) });
    totalBytes += entry.bytes;
  }
  const city = readCityManifest(options.cityManifestPath);
  const classification = classifyArtifactSize(totalBytes);
  const cityTileFiles = files.filter((file) => file.path.startsWith('data/city-tiles/')).length;
  const museumFiles = files.filter((file) => file.path.startsWith('data/museum/')).length;
  return {
    schemaVersion: 1,
    generator: options.generator ?? 'scripts/qa/build-pages.mjs',
    commitSha: options.commitSha ?? null,
    city,
    files,
    directories: collectDirectories(sortedEntries),
    totalBytes,
    warningThresholdBytes: WARNING_THRESHOLD_BYTES,
    warning: classification.warning,
    fatalError: classification.fatalError,
    counts: {
      files: files.length,
      cityTileFiles,
      cityTiles: Math.max(0, cityTileFiles - 1),
      museumFiles,
    },
  };
}

export function formatArtifactManifest(manifest: ArtifactManifest): string {
  return `${JSON.stringify(manifest, null, 1)}\n`;
}

export function validateCityPayload(entries: ArtifactEntry[], cityManifestPath: string, city: CitySummary): Problem[] {
  const problems: Problem[] = [];
  const actual = new Map<string, ArtifactEntry>();
  let nestedTilePath: string | null = null;
  for (const entry of entries) {
    if (!entry.sitePath.startsWith('data/city-tiles/')) continue;
    const name = entry.sitePath.slice('data/city-tiles/'.length);
    if (name.includes('/')) {
      nestedTilePath ??= entry.sitePath;
      continue;
    }
    actual.set(name, entry);
  }
  if (nestedTilePath) {
    problems.push({ code: 'city-tile-unexpected', path: nestedTilePath, message: 'city tiles must stay flat: data/city-tiles/<x>_<y>.json' });
  }

  const manifestEntry = actual.get('manifest.json');
  actual.delete('manifest.json');
  if (!manifestEntry) {
    problems.push({ code: 'city-manifest-missing', path: 'data/city-tiles/manifest.json', message: 'published city manifest is missing' });
    return problems;
  }
  let parsed: ParsedCityManifest;
  try {
    parsed = parseCityManifest(manifestEntry.sourcePath);
  } catch (error) {
    problems.push({
      code: 'city-manifest-invalid',
      path: 'data/city-tiles/manifest.json',
      message: error instanceof Error ? error.message : String(error),
    });
    return problems;
  }
  const manifestSha256 = sha256File(manifestEntry.sourcePath);
  if (manifestSha256 !== city.manifestSha256) {
    problems.push({ code: 'city-manifest-hash-mismatch', path: 'data/city-tiles/manifest.json', message: 'site manifest is not the accepted city manifest' });
  }
  if (parsed.tiles.length !== city.tileCount) {
    problems.push({ code: 'city-manifest-count-mismatch', message: `city manifest has ${parsed.tiles.length} tiles, summary has ${city.tileCount}` });
  }
  const range = parsed.tileRange;
  if (!range) {
    problems.push({ code: 'city-manifest-range-missing', path: 'data/city-tiles/manifest.json', message: 'city manifest has no tileRange' });
    return problems;
  }
  if (![range.minX, range.minY, range.maxX, range.maxY].every(Number.isInteger) || range.maxX < range.minX || range.maxY < range.minY) {
    problems.push({ code: 'city-manifest-range-invalid', path: 'data/city-tiles/manifest.json', message: 'tileRange is not an inclusive integer rectangle' });
    return problems;
  }
  const expectedCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
  if (parsed.tiles.length !== expectedCount) {
    problems.push({
      code: 'city-incomplete',
      message: `city manifest lists ${parsed.tiles.length} tiles but its address range needs ${expectedCount}`,
    });
  }
  const expected = new Map<string, { x: number; y: number; bytes: number }>();
  for (const tile of parsed.tiles) {
    const name = basename(tile.file.replace(/^tiles\//, ''));
    if (name !== `${tile.x}_${tile.y}.json`) {
      problems.push({ code: 'city-tile-address-mismatch', path: name, message: `tile address ${tile.x},${tile.y} does not match file ${tile.file}` });
      continue;
    }
    if (tile.x < range.minX || tile.x > range.maxX || tile.y < range.minY || tile.y > range.maxY) {
      problems.push({ code: 'city-tile-out-of-range', path: name, message: `tile ${tile.x},${tile.y} is outside the accepted tileRange` });
    }
    if (expected.has(name)) {
      problems.push({ code: 'city-tile-duplicate', path: name, message: 'duplicate tile address in city manifest' });
      continue;
    }
    expected.set(name, { x: tile.x, y: tile.y, bytes: tile.bytes });
  }
  for (const [name, tile] of expected) {
    const entry = actual.get(name);
    if (!entry) {
      problems.push({ code: 'city-tile-missing', path: `data/city-tiles/${name}`, message: `accepted tile ${name} is missing from the artifact` });
      continue;
    }
    if (entry.bytes !== tile.bytes) {
      problems.push({
        code: 'city-tile-bytes-mismatch',
        path: `data/city-tiles/${name}`,
        message: `accepted tile is ${tile.bytes} bytes but the artifact has ${entry.bytes}`,
      });
    }
  }
  for (const [name, entry] of actual) {
    if (!expected.has(name)) {
      problems.push({ code: 'city-tile-unexpected', path: entry.sitePath, message: `tile ${name} is not in the accepted city manifest` });
    }
  }
  if (actual.size !== expected.size) {
    problems.push({ code: 'city-tile-count-mismatch', message: `artifact has ${actual.size} tile files, accepted manifest has ${expected.size}` });
  }
  const expectedBytes = parsed.tiles.reduce((sum, tile) => sum + tile.bytes, 0);
  if (city.tileBytes !== expectedBytes) {
    problems.push({ code: 'city-manifest-bytes-mismatch', message: `city summary bytes ${city.tileBytes} != manifest tile bytes ${expectedBytes}` });
  }
  if (city.tileRange && (city.tileRange.minX !== range.minX || city.tileRange.minY !== range.minY || city.tileRange.maxX !== range.maxX || city.tileRange.maxY !== range.maxY)) {
    problems.push({ code: 'city-manifest-range-mismatch', message: 'city summary tileRange differs from the published manifest' });
  }
  return problems;
}

export function manifestMismatch(stored: ArtifactManifest, computed: ArtifactManifest): Problem[] {
  const problems: Problem[] = [];
  const push = (code: string, message: string, path?: string): void => {
    problems.push({ code, message, path });
  };
  if (stored.schemaVersion !== 1) push('stored-manifest-schema', 'site-manifest.json has an unsupported schemaVersion');
  if (stored.totalBytes !== computed.totalBytes) {
    push('stored-manifest-mismatch', `site-manifest.json totalBytes ${stored.totalBytes} != ${computed.totalBytes}`);
  }
  if (stored.directories.join('\u0000') !== computed.directories.join('\u0000')) {
    push('stored-manifest-mismatch', 'site-manifest.json directories do not match the artifact');
  }
  if (stored.city.manifestSha256 !== computed.city.manifestSha256) {
    push('stored-manifest-mismatch', 'site-manifest.json city manifest hash does not match the artifact');
  }
  if (stored.city.tileCount !== computed.city.tileCount) {
    push('stored-manifest-mismatch', 'site-manifest.json city tile count does not match the artifact');
  }
  if (stored.warning !== computed.warning || stored.fatalError !== computed.fatalError) {
    push('stored-manifest-mismatch', 'site-manifest.json warning/fatal classification is stale');
  }
  if (stored.files.length !== computed.files.length) {
    push('stored-manifest-file-count', `site-manifest.json lists ${stored.files.length} files, artifact has ${computed.files.length}`);
  }
  const storedFiles = new Map(stored.files.map((file) => [file.path, file]));
  for (const file of computed.files) {
    const candidate = storedFiles.get(file.path);
    if (!candidate || candidate.bytes !== file.bytes || candidate.sha256 !== file.sha256) {
      push('stored-manifest-file-mismatch', `site-manifest.json is stale for ${file.path}`, file.path);
    }
  }
  for (const file of stored.files) {
    if (!computed.files.some((candidate) => candidate.path === file.path)) {
      push('stored-manifest-file-mismatch', `site-manifest.json lists a file that is not in the artifact: ${file.path}`, file.path);
    }
  }
  if (stored.commitSha && computed.commitSha && stored.commitSha !== computed.commitSha) {
    push('stored-manifest-commit', `site-manifest.json commit ${stored.commitSha} != ${computed.commitSha}`);
  }
  return problems;
}

export function loadAssetLicenses(assetLicensesPath: string): AssetLicensesFile {
  const doc = assertJsonRecord(JSON.parse(readFileSync(assetLicensesPath, 'utf8')) as unknown, 'asset-licenses.json');
  if (doc.schemaVersion !== 1) throw new PublicationError('asset-licenses.json must declare schemaVersion 1');
  if (!Array.isArray(doc.entries)) throw new PublicationError('asset-licenses.json must contain an entries array');
  return doc as unknown as AssetLicensesFile;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateAssetLicenses(document: AssetLicensesFile): Problem[] {
  const problems: Problem[] = [];
  const fail = (code: string, message: string, entryId?: string): void => {
    problems.push({ code, path: entryId, message });
  };
  if (!isNonEmptyString(document.generatedAt)) fail('licence-schema', 'asset-licenses.json needs a generatedAt date');
  if (!isNonEmptyString(document.project)) fail('licence-schema', 'asset-licenses.json needs a project name');
  if (!Array.isArray(document.entries) || document.entries.length === 0) {
    fail('licence-schema', 'asset-licenses.json needs at least one third-party entry');
    return problems;
  }
  const codeEntry = document.code;
  if (!codeEntry || typeof codeEntry !== 'object') {
    fail('licence-schema', 'asset-licenses.json needs a code licence block');
  } else {
    if (codeEntry.status !== 'verified' && codeEntry.status !== 'owner_required') {
      fail('licence-schema', 'code.status must be "verified" or "owner_required"', 'code');
    }
    if (codeEntry.status === 'owner_required' && !isNonEmptyString(codeEntry.ownerDecision)) {
      fail('licence-schema', 'an owner_required code licence must explain the owner decision', 'code');
    }
    if (codeEntry.status === 'verified' && !isNonEmptyString(codeEntry.license)) {
      fail('licence-schema', 'a verified code licence must name a licence', 'code');
    }
    if (!Array.isArray(codeEntry.paths) || codeEntry.paths.length === 0) {
      fail('licence-schema', 'code.paths must be a non-empty array', 'code');
    }
  }
  const ids = new Set<string>();
  for (const entry of document.entries) {
    const id = isNonEmptyString(entry.id) ? entry.id : '<unknown>';
    if (!isNonEmptyString(entry.id)) fail('licence-schema', 'licence entries need an id');
    if (ids.has(id)) fail('licence-duplicate-id', `duplicate licence entry id ${id}`, id);
    ids.add(id);
    if (!isNonEmptyString(entry.name)) fail('licence-schema', `entry ${id} needs a name`, id);
    if (!isNonEmptyString(entry.kind)) fail('licence-schema', `entry ${id} needs a kind`, id);
    if (typeof entry.thirdParty !== 'boolean') fail('licence-schema', `entry ${id} needs thirdParty: true/false`, id);
    if (
      !Array.isArray(entry.artifactPaths) ||
      (entry.artifactPaths.length === 0 && entry.sourceOnly !== true) ||
      entry.artifactPaths.some((value) => !isNonEmptyString(value))
    ) {
      fail('licence-schema', `entry ${id} needs artifactPaths (or sourceOnly: true when it is not shipped)`, id);
    }
    if (typeof entry.modified !== 'boolean') fail('licence-schema', `entry ${id} needs modified: true/false`, id);
    if (entry.redistribution !== true && entry.redistribution !== false && entry.redistribution !== null) {
      fail('licence-schema', `entry ${id} redistribution must be true, false or null`, id);
    }
    if (entry.status !== 'verified' && entry.status !== 'owner_required') {
      fail('licence-schema', `entry ${id} status must be "verified" or "owner_required"`, id);
    }
    if (entry.status === 'owner_required' && !isNonEmptyString(entry.reason)) {
      fail('licence-owner-required-without-reason', `entry ${id} is owner_required but does not say why`, id);
    }
    if (entry.redistribution === null && entry.status !== 'owner_required') {
      fail('licence-unknown-redistribution', `entry ${id} has unknown redistribution but is not marked owner_required`, id);
    }
    if (entry.thirdParty) {
      if (!isNonEmptyString(entry.license)) fail('licence-missing-license', `third-party entry ${id} has no licence`, id);
      if (!isNonEmptyString(entry.source)) fail('licence-missing-source', `third-party entry ${id} has no upstream source`, id);
      if (!isNonEmptyString(entry.attribution)) fail('licence-missing-attribution', `third-party entry ${id} has no attribution text`, id);
      if (entry.redistribution !== true && entry.redistribution !== null) {
        fail('licence-redistribution-denied', `third-party entry ${id} explicitly denies redistribution but is published`, id);
      }
    }
  }
  const osm = document.entries.find((entry) => /openstreetmap|\bosm\b/i.test(`${entry.id} ${entry.name}`));
  if (!osm) fail('licence-osm-missing', 'asset-licenses.json must describe the OSM-derived database');
  else {
    if (!isNonEmptyString(osm.license) || !/ODbL/i.test(osm.license)) fail('licence-osm', 'the OSM-derived database must be licensed under ODbL', osm.id);
    if (osm.redistribution !== true) fail('licence-osm', 'the ODbL database notice must allow redistribution', osm.id);
    if (osm.modified !== true) fail('licence-osm', 'the derived tile database must declare modified: true', osm.id);
  }
  return problems;
}

export interface AuditOptions {
  repoRoot: string;
  entries: ArtifactEntry[];
  manifest: ArtifactManifest;
  /** Plan-mode tests can omit the built app; production builds require it. */
  requireAppBundle?: boolean;
}

function findEntry(entries: ArtifactEntry[], sitePath: string): ArtifactEntry | undefined {
  return entries.find((entry) => entry.sitePath === sitePath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function auditArtifact(options: AuditOptions): ArtifactAudit {
  const repoRoot = resolve(options.repoRoot);
  const { entries, manifest } = options;
  const requireAppBundle = options.requireAppBundle ?? true;
  const errors: Problem[] = validateArtifactPaths(entries);
  const warnings: Problem[] = [];
  const legalErrors: Problem[] = [];
  const ownerRequired: string[] = [];

  const required = REQUIRED_ARTIFACT_PATHS.map((sitePath) => ({ path: sitePath, present: Boolean(findEntry(entries, sitePath)) }));
  for (const item of required) {
    if (item.present) continue;
    if (item.path === 'index.html' && !requireAppBundle) continue;
    errors.push({ code: 'artifact-file-missing', path: item.path, message: `required artifact file is missing: ${item.path}` });
  }

  const publishedCityManifest = findEntry(entries, 'data/city-tiles/manifest.json');
  if (publishedCityManifest) {
    errors.push(...validateCityPayload(entries, publishedCityManifest.sourcePath, manifest.city));
  } else {
    errors.push({ code: 'city-manifest-missing', path: 'data/city-tiles/manifest.json', message: 'published city manifest is missing' });
  }
  errors.push(...scanForbiddenContent(entries));

  if (manifest.fatalError) {
    errors.push({
      code: 'artifact-too-large-fatal',
      message: `artifact is ${manifest.totalBytes} bytes, above the fatal ${FATAL_TOTAL_BYTES}-byte limit; do not delete city tiles to hide this`,
    });
  } else if (manifest.warning) {
    warnings.push({
      code: 'artifact-large-warning',
      message: `artifact is ${manifest.totalBytes} bytes, above the ${WARNING_THRESHOLD_BYTES}-byte warning threshold`,
    });
  }

  const attributionEntry = findEntry(entries, 'data/ATTRIBUTION.md');
  const licenceEntry = findEntry(entries, 'data/LICENSE-ODbL.txt');
  const museumManifestEntry = findEntry(entries, 'data/museum/manifest.json');
  const museumBinaryEntry = findEntry(entries, 'data/museum/exhibits.bin');
  const assetLicensesEntry = findEntry(entries, 'asset-licenses.json');

  if (attributionEntry) {
    const attribution = readFileSync(attributionEntry.sourcePath, 'utf8');
    if (!attribution.includes('OpenStreetMap')) {
      errors.push({ code: 'osm-notice-missing', path: attributionEntry.sitePath, message: 'ATTRIBUTION.md does not name OpenStreetMap' });
    }
    if (!/ODbL 1\.0/i.test(attribution)) {
      errors.push({ code: 'osml-licence-notice-missing', path: attributionEntry.sitePath, message: 'ATTRIBUTION.md does not state the ODbL 1.0 licence' });
    }
  }
  if (licenceEntry) {
    const licence = readFileSync(licenceEntry.sourcePath, 'utf8');
    if (!licence.includes('Open Data Commons') || !/Open Database License/i.test(licence) || !/ODbL/.test(licence)) {
      errors.push({ code: 'odbl-text-missing', path: licenceEntry.sitePath, message: 'LICENSE-ODbL.txt is not the Open Database License 1.0 text' });
    }
  }

  let museumExhibits: { slug: string }[] = [];
  if (museumManifestEntry) {
    try {
      const museum = assertJsonRecord(JSON.parse(readFileSync(museumManifestEntry.sourcePath, 'utf8')) as unknown, 'museum manifest');
      museumExhibits = assertJsonArray(museum.exhibits, 'museum manifest.exhibits').map((raw, index) => {
        const exhibit = assertJsonRecord(raw, `museum manifest.exhibits[${index}]`);
        return { slug: assertString(exhibit.slug, `museum manifest.exhibits[${index}].slug`) };
      });
      const byteLength = assertNumber(museum.byteLength, 'museum manifest.byteLength');
      if (museumBinaryEntry && museumBinaryEntry.bytes !== byteLength) {
        errors.push({
          code: 'museum-binary-size-mismatch',
          path: museumBinaryEntry.sitePath,
          message: `museum manifest declares ${byteLength} bytes but exhibits.bin has ${museumBinaryEntry.bytes}`,
        });
      }
    } catch (error) {
      errors.push({
        code: 'museum-manifest-invalid',
        path: museumManifestEntry.sitePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let thirdPartyAssets = 0;
  let assetLicences: AssetLicensesFile | null = null;
  if (assetLicensesEntry) {
    try {
      assetLicences = loadAssetLicenses(assetLicensesEntry.sourcePath);
      const schemaProblems = validateAssetLicenses(assetLicences);
      errors.push(...schemaProblems);
      for (const entry of assetLicences.entries) {
        if (!entry.thirdParty) continue;
        thirdPartyAssets += 1;
        if (entry.redistribution !== true) {
          const problem: Problem = {
            code: 'third-party-redistribution-owner-required',
            path: assetLicensesEntry.sitePath,
            message: `${entry.id} lacks an evidenced redistribution right; publication must fail closed until the owner resolves it`,
          };
          legalErrors.push(problem);
          errors.push(problem);
        }
      }
      if (assetLicences.code.status === 'owner_required') {
        if (isNonEmptyString(assetLicences.code.license)) {
          errors.push({
            code: 'code-license-invented',
            message: 'asset-licenses.json claims a source-code licence that no LICENSE file grants',
          });
        }
        ownerRequired.push('source-code-license');
        warnings.push({
          code: 'code-license-owner-required',
          message: 'the repository source code has no selected licence; it must not be described as open source',
        });
      } else if (!isNonEmptyString(assetLicences.code.license)) {
        errors.push({ code: 'code-license-invented', message: 'verified code licence has no licence name' });
      }
      for (const entry of assetLicences.entries) {
        if (entry.status === 'owner_required' && entry.id !== 'repository-source-code') ownerRequired.push(entry.id);
      }
    } catch (error) {
      errors.push({
        code: 'licence-inventory-invalid',
        path: assetLicensesEntry.sitePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (requireAppBundle) {
    legalErrors.push({ code: 'licence-inventory-missing', message: 'asset-licenses.json is not published' });
  }

  // Museum provenance: every shipped exhibit must have a recorded licence and attribution.
  const modelsPath = join(repoRoot, 'assets', 'aviation-museum', 'MODELS.json');
  const models = existsSync(modelsPath)
    ? (JSON.parse(readFileSync(modelsPath, 'utf8')) as {
        items: { slug: string; label: string; status: string; author: string | null; license: string | null; uid?: string | null; url?: string | null }[];
      })
    : null;
  const attributionText = attributionEntry ? readFileSync(attributionEntry.sourcePath, 'utf8') : '';
  const licencedSlugs = new Set((assetLicences?.entries ?? []).filter((entry) => entry.exhibitSlug).map((entry) => entry.exhibitSlug));
  const shippedSlugs = [...new Set(museumExhibits.map((exhibit) => exhibit.slug))];
  for (const slug of shippedSlugs) {
    const model = models?.items.find((item) => item.slug === slug && item.status === 'downloaded');
    if (!models) {
      errors.push({ code: 'museum-provenance-missing', message: 'assets/aviation-museum/MODELS.json is not available to verify museum asset rights' });
      break;
    }
    if (!model) {
      errors.push({ code: 'museum-provenance-missing', message: `museum payload ships ${slug} but MODELS.json has no downloaded record` });
      continue;
    }
    if (!isNonEmptyString(model.license) || !isNonEmptyString(model.author) || !(isNonEmptyString(model.uid) || isNonEmptyString(model.url))) {
      errors.push({ code: 'museum-provenance-incomplete', message: `MODELS.json lacks licence/author/source for ${slug}` });
    }
    if (!licencedSlugs.has(slug)) {
      errors.push({ code: 'museum-license-missing', message: `asset-licenses.json has no entry for shipped exhibit ${slug}` });
    }
    if (isNonEmptyString(model.author) && !attributionText.includes(model.author)) {
      errors.push({ code: 'museum-attribution-missing', message: `ATTRIBUTION.md does not name ${model.author} (${slug})` });
    }
  }

  // The committed human-readable report should list every shipped exhibit; this
  // is a release-checklist warning rather than a rights failure.
  const licencesReport = join(repoRoot, 'assets', 'aviation-museum', 'LICENSES.md');
  if (shippedSlugs.length > 0 && existsSync(licencesReport)) {
    const reportText = readFileSync(licencesReport, 'utf8');
    const missing = shippedSlugs.filter((slug) => !new RegExp(`\\(${escapeRegExp(slug)}\\)`).test(reportText));
    if (missing.length > 0) {
      warnings.push({
        code: 'licenses-report-stale',
        message: `assets/aviation-museum/LICENSES.md does not list ${missing.join(', ')}; regenerate scripts/qa/museum_licenses.py before release`,
      });
    }
  }

  const indexEntry = findEntry(entries, 'index.html');
  if (indexEntry) {
    const html = readFileSync(indexEntry.sourcePath, 'utf8');
    const scriptSources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
    if (scriptSources.some((source) => source.startsWith('/'))) {
      errors.push({
        code: 'absolute-app-base',
        path: 'index.html',
        message: 'index.html references absolute script paths; the app must work below /VoxelMinsk/',
      });
    }
    const bundleText = entries
      .filter((entry) => /\.(?:js|mjs)$/i.test(entry.sitePath))
      .map((entry) => readFileSync(entry.sourcePath, 'utf8'))
      .join('\n');
    if (!bundleText.includes('OpenStreetMap') || !/ODbL/.test(bundleText)) {
      errors.push({ code: 'ui-attribution-missing', message: 'the built JavaScript does not contain the visible OSM/ODbL attribution' });
    }
    if (!scriptSources.some((source) => /\.(?:js|mjs)$/i.test(source))) {
      errors.push({ code: 'app-bundle-missing', path: 'index.html', message: 'index.html does not reference a JavaScript bundle' });
    }
  } else if (requireAppBundle) {
    errors.push({ code: 'app-bundle-missing', path: 'index.html', message: 'the artifact has no built index.html' });
  }

  const legalStatus: LegalAudit['status'] =
    legalErrors.length > 0 ? 'fail' : ownerRequired.length > 0 ? 'pass_with_owner_required' : 'pass';
  const legal: LegalAudit = { status: legalStatus, ownerRequired, thirdPartyAssets, errors: legalErrors, warnings: warnings.filter((warning) => warning.code.startsWith('code-license')) };

  const city = {
    version: manifest.city.version,
    expectedTiles: manifest.city.tileRange
      ? (manifest.city.tileRange.maxX - manifest.city.tileRange.minX + 1) * (manifest.city.tileRange.maxY - manifest.city.tileRange.minY + 1)
      : manifest.city.tileCount,
    presentTiles: entries.filter((entry) => /^data\/city-tiles\/[^/]+\.json$/.test(entry.sitePath) && !entry.sitePath.endsWith('/manifest.json')).length,
    tileBytes: entries
      .filter((entry) => /^data\/city-tiles\/[^/]+\.json$/.test(entry.sitePath) && !entry.sitePath.endsWith('/manifest.json'))
      .reduce((sum, entry) => sum + entry.bytes, 0),
    manifestSha256: manifest.city.manifestSha256,
  };

  return { ok: errors.length === 0, errors, warnings, legal, required, city };
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed) throw new PublicationError('nested base path must not be empty');
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/**
 * Minimal static server that mounts an artifact below a project prefix, e.g.
 * `/VoxelMinsk/`, so the release check never relies on a dev-server root alias.
 */
export async function startNestedStaticServer(options: {
  siteRoot: string;
  basePath?: string;
  host?: string;
  port?: number;
}): Promise<NestedStaticServer> {
  const siteRoot = requireDirectory(resolve(options.siteRoot), 'artifact site root');
  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_NESTED_BASE);
  const host = options.host ?? '127.0.0.1';

  const server = createServer((request, response) => {
    const pathPart = (request.url ?? '/').split('?')[0] ?? '/';
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('bad request');
      return;
    }
    const notFound = (): void => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
      response.end('not found');
    };
    if (!(decoded === basePath.slice(0, -1) || decoded.startsWith(basePath))) {
      notFound();
      return;
    }
    if (decoded === basePath.slice(0, -1)) {
      response.writeHead(301, { location: basePath });
      response.end();
      return;
    }
    let relativePath = decoded.slice(basePath.length).replace(/^\/+/, '');
    if (relativePath === '' || relativePath.endsWith('/')) relativePath += 'index.html';
    const normalized = posix.normalize(relativePath);
    if (normalized.startsWith('..') || posix.isAbsolute(normalized)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('forbidden');
      return;
    }
    const target = resolve(siteRoot, ...normalized.split('/'));
    if (!isStrictlyInside(siteRoot, target)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('forbidden');
      return;
    }
    let stats;
    try {
      stats = statSync(target);
    } catch {
      notFound();
      return;
    }
    if (stats.isDirectory()) {
      const indexTarget = join(target, 'index.html');
      try {
        stats = statSync(indexTarget);
      } catch {
        notFound();
        return;
      }
      if (!stats.isFile()) {
        notFound();
        return;
      }
      response.writeHead(200, {
        'content-type': mimeTypeFor(indexTarget),
        'content-length': String(stats.size),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      response.end(readFileSync(indexTarget));
      return;
    }
    if (!stats.isFile()) {
      notFound();
      return;
    }
    response.writeHead(200, {
      'content-type': mimeTypeFor(target),
      'content-length': String(stats.size),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(readFileSync(target));
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw new PublicationError('nested static server did not bind a TCP port');
  }
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    baseUrl: `${origin}${basePath}`,
    server,
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    }),
  };
}

/** Relative path from `repoRoot` for reports; keeps host-specific absolutes out of committable JSON. */
export function repoRelative(repoRoot: string, target: string): string {
  return toPosix(relative(resolve(repoRoot), resolve(target)));
}

export function describePathSafety(repoRoot: string, candidate: string): string {
  const root = resolve(repoRoot);
  const target = resolve(candidate);
  if (!isInside(root, target)) return 'outside-repository';
  if (target === root) return 'repository-root';
  return isStrictlyInside(root, target) ? 'inside-repository' : 'unknown';
}
