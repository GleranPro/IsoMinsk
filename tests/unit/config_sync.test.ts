/**
 * Isometric Minsk — config sync guard.
 *
 * The Python data pipeline (scripts/geo_config.py) and the TypeScript app
 * (src/shared/config.ts) intentionally mirror the same constants. Nothing
 * enforces that in code generation, so this test parses both source files
 * textually and fails when they drift. It also sanity-checks physical ranges
 * and the isometric camera defaults.
 *
 * Run: pnpm test -- tests/unit/config_sync.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EPSG_UTM35N,
  EPSG_WGS84,
  GROUND_LAYER_Y,
  INGEST_MARGIN_M,
  ISO_CAMERA,
  MAX_BUILDING_HEIGHT_M,
  MIN_BUILDING_HEIGHT_M,
  PILOT_CENTER,
  PILOT_SIZE_M,
  TILE_SIZE_M,
  DEFAULT_FLOOR_HEIGHT_M,
  DATA_BASE_URL,
  TILE_MANIFEST_URL,
  resolveDataBaseUrl,
  resolveDatasetName,
  resolveManifestUrl,
  resolveTileUrl,
} from '../../src/shared/config';
import { publicAssetUrl } from '../../src/shared/assets';
import { MUSEUM } from '../../src/shared/museum';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PY_CONFIG_PATH = path.join(ROOT, 'scripts', 'geo_config.py');
const TS_CONFIG_PATH = path.join(ROOT, 'src', 'shared', 'config.ts');

const pythonSource = readFileSync(PY_CONFIG_PATH, 'utf8');
const typescriptSource = readFileSync(TS_CONFIG_PATH, 'utf8');

/** Reads `NAME = 123.4` / `NAME = 1_600` from the Python config text. */
function pythonNumber(name: string): number {
  const match = pythonSource.match(new RegExp(`^${name}\\s*=\\s*(-?[0-9][0-9_.eE+-]*)`, 'm'));
  if (!match) throw new Error(`${name} not found in ${PY_CONFIG_PATH}`);
  const value = Number(match[1].replace(/_/g, ''));
  if (!Number.isFinite(value)) throw new Error(`${name} is not a finite number in ${PY_CONFIG_PATH}`);
  return value;
}

/** Reads `export const NAME = 123.4;` from the TypeScript config text. */
function typescriptNumber(name: string): number {
  const match = typescriptSource.match(
    new RegExp(`export const ${name}\\s*(?::\\s*[^=]+)?=\\s*(-?[0-9][0-9_.eE+-]*)\\s*;`),
  );
  if (!match) throw new Error(`${name} not found in ${TS_CONFIG_PATH}`);
  const value = Number(match[1].replace(/_/g, ''));
  if (!Number.isFinite(value)) throw new Error(`${name} is not a finite number in ${TS_CONFIG_PATH}`);
  return value;
}

/** Reads a numeric field from the PILOT_CENTER object literal in config.ts. */
function pilotCenterField(field: 'lat' | 'lon'): number {
  const block = typescriptSource.match(/PILOT_CENTER\s*=\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error('PILOT_CENTER object not found in src/shared/config.ts');
  const match = block[1].match(new RegExp(`${field}\\s*:\\s*(-?[0-9][0-9_.eE+-]*)`));
  if (!match) throw new Error(`PILOT_CENTER.${field} not found in src/shared/config.ts`);
  return Number(match[1].replace(/_/g, ''));
}

describe('config sync — Python pipeline vs TypeScript app', () => {
  it('both config files exist and declare the pilot area constants', () => {
    expect(pythonSource.length, 'scripts/geo_config.py should not be empty').toBeGreaterThan(100);
    expect(typescriptSource.length, 'src/shared/config.ts should not be empty').toBeGreaterThan(100);
    expect(pythonSource).toContain('PILOT_CENTER_LAT');
    expect(pythonSource).toContain('PILOT_CENTER_LON');
  });

  it('pilot centre latitude matches', () => {
    expect(pilotCenterField('lat')).toBe(pythonNumber('PILOT_CENTER_LAT'));
    expect(PILOT_CENTER.lat).toBe(pythonNumber('PILOT_CENTER_LAT'));
  });

  it('pilot centre longitude matches', () => {
    expect(pilotCenterField('lon')).toBe(pythonNumber('PILOT_CENTER_LON'));
    expect(PILOT_CENTER.lon).toBe(pythonNumber('PILOT_CENTER_LON'));
  });

  it('PILOT_SIZE_M matches', () => {
    expect(PILOT_SIZE_M).toBe(pythonNumber('PILOT_SIZE_M'));
  });

  it('INGEST_MARGIN_M matches', () => {
    expect(INGEST_MARGIN_M).toBe(pythonNumber('INGEST_MARGIN_M'));
  });

  it('TILE_SIZE_M matches', () => {
    expect(TILE_SIZE_M).toBe(pythonNumber('TILE_SIZE_M'));
  });

  it('EPSG codes match', () => {
    expect(EPSG_WGS84).toBe(pythonNumber('EPSG_WGS84'));
    expect(EPSG_UTM35N).toBe(pythonNumber('EPSG_UTM35N'));
    expect(EPSG_WGS84).toBe(4326);
    expect(EPSG_UTM35N).toBe(32635);
  });

  it('building height + floor constants match', () => {
    expect(DEFAULT_FLOOR_HEIGHT_M).toBe(pythonNumber('DEFAULT_FLOOR_HEIGHT_M'));
    expect(MIN_BUILDING_HEIGHT_M).toBe(pythonNumber('MIN_BUILDING_HEIGHT_M'));
    expect(MAX_BUILDING_HEIGHT_M).toBe(pythonNumber('MAX_BUILDING_HEIGHT_M'));
  });
});

describe('config — physical and pipeline invariants', () => {
  it('pilot centre is a valid WGS84 location in central Minsk', () => {
    expect(PILOT_CENTER.lat).toBeGreaterThan(53.5);
    expect(PILOT_CENTER.lat).toBeLessThan(54.3);
    expect(PILOT_CENTER.lon).toBeGreaterThan(27.2);
    expect(PILOT_CENTER.lon).toBeLessThan(27.9);
  });

  it('area and tile sizes are mutually consistent', () => {
    expect(PILOT_SIZE_M).toBeGreaterThanOrEqual(TILE_SIZE_M);
    expect(TILE_SIZE_M).toBeGreaterThan(0);
    expect(INGEST_MARGIN_M).toBeGreaterThanOrEqual(0);
    // The render area spans several tiles (tile loading would be pointless
    // otherwise), and ingestion must be padded beyond the render area.
    expect(PILOT_SIZE_M / TILE_SIZE_M).toBeGreaterThan(1);
    expect(INGEST_MARGIN_M).toBeGreaterThan(0);
    expect(INGEST_MARGIN_M).toBeLessThan(PILOT_SIZE_M);
  });

  it('building height range is physically plausible', () => {
    expect(MIN_BUILDING_HEIGHT_M).toBeGreaterThan(0);
    expect(MAX_BUILDING_HEIGHT_M).toBeGreaterThan(MIN_BUILDING_HEIGHT_M);
    expect(MAX_BUILDING_HEIGHT_M).toBeLessThanOrEqual(1000);
    expect(DEFAULT_FLOOR_HEIGHT_M).toBeGreaterThan(2);
    expect(DEFAULT_FLOOR_HEIGHT_M).toBeLessThan(6);
  });

  it('isometric camera defaults are coherent', () => {
    expect(ISO_CAMERA.azimuth).toBeCloseTo(Math.PI / 4, 12);
    expect(ISO_CAMERA.elevation).toBeCloseTo(Math.atan(1 / Math.SQRT2), 12);
    expect(ISO_CAMERA.orthoHeight).toBeGreaterThan(ISO_CAMERA.minOrthoHeight);
    expect(ISO_CAMERA.orthoHeight).toBeLessThan(ISO_CAMERA.maxOrthoHeight);
    expect(ISO_CAMERA.near).toBeGreaterThan(0);
    expect(ISO_CAMERA.far).toBeGreaterThan(ISO_CAMERA.distance);
    expect(ISO_CAMERA.distance).toBeGreaterThan(ISO_CAMERA.maxOrthoHeight);
  });

  it('ground anti-z-fighting layer heights are small, non-negative and distinct', () => {
    const layers = Object.values(GROUND_LAYER_Y);
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) {
      expect(layer).toBeGreaterThanOrEqual(0);
      expect(layer).toBeLessThan(1);
    }
    expect(new Set(layers).size).toBe(layers.length);
    expect(GROUND_LAYER_Y.base).toBe(0);
  });
});

describe('config — complete-city-only public payload', () => {
  /**
   * Every form that has ever been published or bookmarked. The application
   * serves the complete city for all of them: there is no pilot, staging or
   * central dataset behind a query parameter.
   */
  const LEGACY_SEARCHES = ['', '?dataset=city', '?dataset=central', '?dataset=potato'];

  it('always serves the complete city, including legacy links', () => {
    for (const search of LEGACY_SEARCHES) {
      const label = `search "${search}"`;
      expect(resolveDatasetName(search), `dataset for ${label}`).toBe('city');
      expect(resolveDataBaseUrl(search), `data base for ${label}`).toBe('./data/city-tiles');
      expect(resolveManifestUrl(search), `manifest for ${label}`).toBe(
        './data/city-tiles/manifest.json',
      );
      expect(resolveTileUrl('tiles/-11_-9.json', search), `tile for ${label}`).toBe(
        './data/city-tiles/-11_-9.json',
      );
    }
  });

  it('resolves the same complete-city endpoints without an explicit search', () => {
    expect(resolveDatasetName()).toBe('city');
    expect(resolveDataBaseUrl()).toBe('./data/city-tiles');
    expect(resolveManifestUrl()).toBe('./data/city-tiles/manifest.json');
    expect(resolveTileUrl('tiles/12_-4.json')).toBe('./data/city-tiles/12_-4.json');
  });

  it('keeps every public payload URL project-relative, never root-absolute', () => {
    const urls = [
      resolveDataBaseUrl(),
      resolveManifestUrl(),
      resolveTileUrl('tiles/0_0.json'),
      resolveManifestUrl('?dataset=central'),
    ];
    for (const url of urls) {
      expect(url.startsWith('/'), `${url} must not be root-absolute`).toBe(false);
      expect(url.startsWith('./'), `${url} must be project-relative`).toBe(true);
    }
  });

  it('exports the same endpoints the engine defaults consume', () => {
    expect(DATA_BASE_URL).toBe(resolveDataBaseUrl());
    expect(TILE_MANIFEST_URL).toBe(resolveManifestUrl());
    expect(DATA_BASE_URL).toBe('./data/city-tiles');
    expect(TILE_MANIFEST_URL).toBe('./data/city-tiles/manifest.json');
  });

  it('routes the museum payload below the same deployment base', () => {
    expect(MUSEUM.dataUrl).toBe('./data/museum');
    expect(publicAssetUrl('data/museum')).toBe('./data/museum');
    expect(publicAssetUrl('data/museum', '/VoxelMinsk/')).toBe('/VoxelMinsk/data/museum');
  });
});

describe('assets — public asset URLs below the deployment base', () => {
  it('defaults to a document-relative path at the root base', () => {
    expect(publicAssetUrl('data/city-tiles')).toBe('./data/city-tiles');
    expect(publicAssetUrl('data/museum')).toBe('./data/museum');
    expect(publicAssetUrl('data/museum/manifest.json')).toBe('./data/museum/manifest.json');
  });

  it('strips leading slashes so paths are never double-prefixed', () => {
    expect(publicAssetUrl('/data/city-tiles')).toBe('./data/city-tiles');
    expect(publicAssetUrl('///data/museum/exhibits.bin')).toBe('./data/museum/exhibits.bin');
    expect(publicAssetUrl('/data/city-tiles', '/VoxelMinsk/')).toBe('/VoxelMinsk/data/city-tiles');
  });

  it('resolves below an explicit project base such as GitHub Pages', () => {
    expect(publicAssetUrl('data/city-tiles', '/VoxelMinsk/')).toBe('/VoxelMinsk/data/city-tiles');
    expect(publicAssetUrl('data/museum/manifest.json', '/VoxelMinsk/')).toBe(
      '/VoxelMinsk/data/museum/manifest.json',
    );
  });

  it('appends the trailing slash to a configured base that omits it', () => {
    expect(publicAssetUrl('data/city-tiles', '/VoxelMinsk')).toBe('/VoxelMinsk/data/city-tiles');
  });

  it('keeps the root base relative and leaves absolute asset bases intact', () => {
    expect(publicAssetUrl('data/city-tiles', '/')).toBe('./data/city-tiles');
    expect(publicAssetUrl('data/city-tiles', '')).toBe('./data/city-tiles');
    expect(publicAssetUrl('data/city-tiles', 'https://example.test/app/')).toBe(
      'https://example.test/app/data/city-tiles',
    );
  });
});
