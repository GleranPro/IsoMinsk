/**
 * Isometric Minsk — validation of the REAL generated city data.
 *
 * These tests read `public/data/tiles/manifest.json` and every tile JSON the
 * manifest references. No fixture data is fabricated: if the pipeline has not
 * produced the tiles yet, the suite is skipped with an explicit warning (and
 * the QA report says so).
 *
 * What is verified:
 *  - manifest schema, projection, tile range/bounds/pilotBounds and attribution;
 *  - every declared tile file exists, parses and agrees with its index entry;
 *  - manifest counts agree with the actual tile payloads;
 *  - buildings: unique ids across ALL tiles (one owning tile per building),
 *    plain FeatureId format, 2..400 m heights, non-empty valid rings with
 *    >= 3 finite points, sane volume heights, known archetype / roof shape /
 *    height source values, optional `levels` omitted (not null) when unknown;
 *  - roads, surfaces and trees: valid geometry, no NaN, known enum values;
 *  - crossingBuildingIds point at buildings that are owned elsewhere;
 *  - every tile near the pilot centre carries roads or surfaces.
 *
 * Run: pnpm test -- tests/unit/data
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EPSG_UTM35N,
  MAX_BUILDING_HEIGHT_M,
  PILOT_CENTER,
  PILOT_SIZE_M,
  TILE_SIZE_M,
} from '../../../src/shared/config';
import { ringArea, tileBounds } from '../../../src/shared/tileMath';
import type {
  Ring,
  TileData,
  TileIndexEntry,
  TileManifest,
} from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// locate + load the generated data (once)
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(fileURLToPath(new URL('../../../public/data', import.meta.url)));
const TILES_DIR = path.join(DATA_DIR, 'tiles');
const MANIFEST_PATH = path.join(TILES_DIR, 'manifest.json');
const DATA_AVAILABLE = existsSync(MANIFEST_PATH);

if (!DATA_AVAILABLE) {
  console.warn(
    `[data tests] SKIPPED — ${MANIFEST_PATH} is not present yet. ` +
      'Generate tiles with `pnpm run data:all` (Python + tsx) and re-run this suite.',
  );
}

interface LoadedTile {
  entry: TileIndexEntry;
  filePath: string;
  data: TileData;
}

const store: { manifest: TileManifest | null; tiles: LoadedTile[] } = {
  manifest: null,
  tiles: [],
};

interface DataAnalysis {
  tileMismatches: string[];
  duplicateBuildingIds: Array<{ id: string; tiles: string[] }>;
  buildingViolations: string[];
  polygonViolations: string[];
  crossingViolations: string[];
  treeViolations: string[];
  counts: {
    buildings: number;
    surfaces: number;
    roads: number;
    trees: number;
    buildingsExplicitHeight: number;
    buildingsWithLevels: number;
    buildingsWithRoofShape: number;
  };
}

let analysis: DataAnalysis;

const ARCHETYPES = new Set([
  'stalin',
  'khrushchev',
  'panel',
  'modern',
  'office',
  'historic',
  'industrial',
  'small',
  'civic',
  // Added with the stadium/palace geometry work (src/shared/types.ts):
  // monumental civic ensembles (palace) and sports arenas (stadium).
  'palace',
  'stadium',
]);
const ROOF_SHAPES = new Set(['flat', 'gabled', 'hipped', 'pyramidal', 'skillion', 'dome', 'complex']);
const HEIGHT_SOURCES = new Set(['osm_height', 'osm_levels', 'heuristic', 'default']);
const SURFACE_KINDS = new Set([
  'grass',
  'park',
  'forest',
  'scrub',
  'water',
  'river',
  'sand',
  'pitch',
  'cemetery',
  'railway',
  'plaza',
  'residential',
  'industrial',
  'commercial',
  'construction',
  'unknown',
]);
const ROAD_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'service',
  'living_street',
  'pedestrian',
  'footway',
  'cycleway',
  'path',
  'steps',
  'track',
  'unknown',
]);
const ROAD_KINDS = new Set(['road', 'footway', 'rail']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validates a ring; returns a problem description or null. */
function ringProblem(ring: unknown): string | null {
  if (!Array.isArray(ring)) return 'ring is not an array';
  if (ring.length < 3) return `ring has ${ring.length} points (< 3)`;
  for (let index = 0; index < ring.length; index += 1) {
    const point = ring[index];
    if (!Array.isArray(point) || point.length !== 2) return `point ${index} is not an [x, y] pair`;
    if (!isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) return `point ${index} has a non-finite coordinate`;
  }
  if (Math.abs(ringArea(ring as Ring)) === 0) return 'ring encloses zero area (degenerate)';
  return null;
}

/** Validates a polygon (exterior ring + holes); returns a problem description or null. */
function polygonProblem(polygon: unknown): string | null {
  if (!Array.isArray(polygon) || polygon.length === 0) return 'polygon has no rings';
  for (let index = 0; index < polygon.length; index += 1) {
    const problem = ringProblem(polygon[index]);
    if (problem) return `ring ${index}: ${problem}`;
  }
  return null;
}

function analyse(manifest: TileManifest, tiles: LoadedTile[]): DataAnalysis {
  const result: DataAnalysis = {
    tileMismatches: [],
    duplicateBuildingIds: [],
    buildingViolations: [],
    polygonViolations: [],
    crossingViolations: [],
    treeViolations: [],
    counts: {
      buildings: 0,
      surfaces: 0,
      roads: 0,
      trees: 0,
      buildingsExplicitHeight: 0,
      buildingsWithLevels: 0,
      buildingsWithRoofShape: 0,
    },
  };

  const owners = new Map<string, string[]>();

  for (const { entry, data } of tiles) {
    const tileName = `${entry.x}_${entry.y}`;

    // Index-entry <-> payload agreement.
    if (data.tileX !== entry.x || data.tileY !== entry.y) {
      result.tileMismatches.push(
        `${tileName}: payload says tileX/tileY ${data.tileX}/${data.tileY}, manifest says ${entry.x}/${entry.y}`,
      );
    }
    const expectedBounds = tileBounds(entry.x, entry.y, manifest.tileSize);
    if (JSON.stringify(data.bounds) !== JSON.stringify(expectedBounds)) {
      result.tileMismatches.push(
        `${tileName}: bounds ${JSON.stringify(data.bounds)} !== tileBounds ${JSON.stringify(expectedBounds)}`,
      );
    }
    if (data.buildings.length !== entry.buildings) {
      result.tileMismatches.push(
        `${tileName}: manifest buildings=${entry.buildings}, payload has ${data.buildings.length}`,
      );
    }

    result.counts.buildings += data.buildings.length;
    result.counts.surfaces += data.surfaces.length;
    result.counts.roads += data.roads.length;
    result.counts.trees += data.trees.length;

    for (const building of data.buildings) {
      const label = `${tileName}/${building.id}`;
      owners.set(building.id, [...(owners.get(building.id) ?? []), tileName]);

      // FeatureId contract (src/shared/types.ts) is exactly `${osmType[0]}${osmId}`.
      // Multipolygon parts are merged into one BuildingFeature with multiple
      // volumes, so no id suffix is allowed.
      if (typeof building.id !== 'string' || !/^[wr][0-9]+$/.test(building.id)) {
        result.buildingViolations.push(`${label}: id does not match the plain FeatureId format /^[wr]\\d+$/`);
      }
      if (building.osmType !== 'way' && building.osmType !== 'relation') {
        result.buildingViolations.push(`${label}: unknown osmType ${String(building.osmType)}`);
      } else if (building.id?.startsWith(building.osmType[0]) === false) {
        result.buildingViolations.push(`${label}: id prefix does not match osmType=${building.osmType}`);
      }
      if (!isFiniteNumber(building.osmId) || building.osmId <= 0) {
        result.buildingViolations.push(`${label}: osmId is not a positive number`);
      }
      if (!ARCHETYPES.has(building.archetype)) {
        result.buildingViolations.push(`${label}: unknown archetype ${String(building.archetype)}`);
      }
      const height = building.height;
      if (!isFiniteNumber(height)) {
        result.buildingViolations.push(`${label}: height is not a finite number`);
      } else if (height < 2 || height > 400) {
        result.buildingViolations.push(`${label}: height ${height} m outside the 2..400 m range`);
      } else if (height > MAX_BUILDING_HEIGHT_M) {
        result.buildingViolations.push(`${label}: height ${height} m exceeds MAX_BUILDING_HEIGHT_M`);
      }
      // `levels?: number` — absent optional values must be omitted, not null.
      if (building.levels === null) {
        result.buildingViolations.push(`${label}: levels is null (must be omitted when unknown)`);
      } else if (building.levels !== undefined) {
        result.counts.buildingsWithLevels += 1;
        if (!Number.isInteger(building.levels) || building.levels < 1 || building.levels > 100) {
          result.buildingViolations.push(`${label}: implausible levels=${String(building.levels)}`);
        }
      }
      if (building.roofShape !== undefined) result.counts.buildingsWithRoofShape += 1;
      if (!ROOF_SHAPES.has(building.roofShape)) {
        result.buildingViolations.push(`${label}: unknown roofShape ${String(building.roofShape)}`);
      }
      if (building.tags === null || typeof building.tags !== 'object' || Array.isArray(building.tags)) {
        result.buildingViolations.push(`${label}: tags is not an object`);
      }
      if (!Array.isArray(building.volumes) || building.volumes.length === 0) {
        result.buildingViolations.push(`${label}: no volumes`);
        continue;
      }

      for (let volumeIndex = 0; volumeIndex < building.volumes.length; volumeIndex += 1) {
        const volume = building.volumes[volumeIndex];
        const volumeLabel = `${label}/v${volumeIndex}`;
        const footprintProblem = polygonProblem(volume.footprint);
        if (footprintProblem) {
          result.polygonViolations.push(`${volumeLabel}: footprint ${footprintProblem}`);
        }
        if (!ROOF_SHAPES.has(volume.roofShape)) {
          result.buildingViolations.push(`${volumeLabel}: unknown volume roofShape ${String(volume.roofShape)}`);
        }
        if (!HEIGHT_SOURCES.has(volume.heightSource)) {
          result.buildingViolations.push(`${volumeLabel}: unknown heightSource ${String(volume.heightSource)}`);
        } else if (volume.heightSource === 'osm_height') {
          result.counts.buildingsExplicitHeight += 1;
        }
        if (!isFiniteNumber(volume.minHeight) || volume.minHeight < 0) {
          result.buildingViolations.push(`${volumeLabel}: minHeight is not a non-negative finite number`);
        }
        if (!isFiniteNumber(volume.height)) {
          result.buildingViolations.push(`${volumeLabel}: height is not a finite number`);
        } else if (isFiniteNumber(volume.minHeight) && volume.height < volume.minHeight) {
          result.buildingViolations.push(`${volumeLabel}: height ${volume.height} < minHeight ${volume.minHeight}`);
        }
        if (!isFiniteNumber(volume.roofHeight) || volume.roofHeight < 0) {
          result.buildingViolations.push(`${volumeLabel}: roofHeight is not a non-negative finite number`);
        }
        if (volume.roofDirection !== undefined && !isFiniteNumber(volume.roofDirection)) {
          result.buildingViolations.push(`${volumeLabel}: roofDirection is not finite`);
        }
      }
    }

    for (const crossingId of data.crossingBuildingIds ?? []) {
      if (data.buildings.some((building) => building.id === crossingId)) {
        result.crossingViolations.push(
          `${tileName}: crossingBuildingIds lists ${crossingId} but this tile also owns it (double ownership)`,
        );
      }
    }
    const crossingIds = data.crossingBuildingIds ?? [];
    if (new Set(crossingIds).size !== crossingIds.length) {
      result.crossingViolations.push(`${tileName}: crossingBuildingIds contains duplicates`);
    }

    for (const road of data.roads) {
      const label = `${tileName}/road(${road.class})`;
      if (!ROAD_KINDS.has(road.kind)) result.polygonViolations.push(`${label}: unknown kind ${String(road.kind)}`);
      if (!ROAD_CLASSES.has(road.class)) result.polygonViolations.push(`${label}: unknown class ${String(road.class)}`);
      if (!isFiniteNumber(road.width) || road.width <= 0) {
        result.polygonViolations.push(`${label}: width is not a positive finite number`);
      }
      const problem = polygonProblem(road.polygon);
      if (problem) result.polygonViolations.push(`${label}: ${problem}`);
    }

    for (const surface of data.surfaces) {
      const label = `${tileName}/surface(${surface.kind})`;
      if (!SURFACE_KINDS.has(surface.kind)) {
        result.polygonViolations.push(`${label}: unknown kind ${String(surface.kind)}`);
      }
      const problem = polygonProblem(surface.polygon);
      if (problem) result.polygonViolations.push(`${label}: ${problem}`);
    }

    for (const tree of data.trees) {
      const label = `${tileName}/tree`;
      if (!isFiniteNumber(tree.x) || !isFiniteNumber(tree.y)) {
        result.treeViolations.push(`${label}: non-finite position`);
      }
      if (!isFiniteNumber(tree.height) || tree.height <= 0 || tree.height > 60) {
        result.treeViolations.push(`${label}: implausible height ${String(tree.height)}`);
      }
      if (!isFiniteNumber(tree.radius) || tree.radius <= 0 || tree.radius > 30) {
        result.treeViolations.push(`${label}: implausible radius ${String(tree.radius)}`);
      }
      if (!isFiniteNumber(tree.variation) || tree.variation < 0 || tree.variation > 1) {
        result.treeViolations.push(`${label}: variation outside 0..1`);
      }
      if (typeof tree.mapped !== 'boolean') {
        result.treeViolations.push(`${label}: mapped is not a boolean`);
      }
    }
  }

  // A building must be owned by exactly one tile.
  for (const [id, owningTiles] of owners) {
    if (owningTiles.length > 1) {
      result.duplicateBuildingIds.push({ id, tiles: owningTiles });
    }
  }

  // crossingBuildingIds must reference a building that some tile owns.
  const knownBuildingIds = new Set(owners.keys());
  for (const { entry, data } of tiles) {
    for (const crossingId of data.crossingBuildingIds ?? []) {
      if (!knownBuildingIds.has(crossingId)) {
        result.crossingViolations.push(
          `${entry.x}_${entry.y}: crossingBuildingIds references unknown building ${crossingId}`,
        );
      }
    }
  }

  return result;
}

function formatProblems(problems: string[], limit = 12): string {
  const head = problems.slice(0, limit).join('\n  ');
  return problems.length > limit ? `${head}\n  … and ${problems.length - limit} more` : head;
}

describe.skipIf(!DATA_AVAILABLE)('generated city data — manifest and tile index', () => {
  beforeAll(() => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as TileManifest;
    store.manifest = manifest;
    store.tiles = manifest.tiles.map((entry) => {
      const filePath = path.join(DATA_DIR, entry.file);
      const data = JSON.parse(readFileSync(filePath, 'utf8')) as TileData;
      return { entry, filePath, data };
    });
    analysis = analyse(manifest, store.tiles);
  }, 180_000);

  it('manifest has the expected schema, projection and attribution', () => {
    const manifest = store.manifest;
    expect(manifest).not.toBeNull();
    if (!manifest) throw new Error('manifest missing');
    expect(typeof manifest.version).toBe('string');
    expect(manifest.version.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(manifest.generatedAt)), 'generatedAt must be an ISO date').toBe(false);
    expect(manifest.epsg).toBe(EPSG_UTM35N);
    expect(manifest.tileSize).toBe(TILE_SIZE_M);
    expect(manifest.originUtm).toHaveLength(2);
    expect(manifest.originUtm.every(isFiniteNumber)).toBe(true);
    expect(manifest.centerLatLon).toHaveLength(2);
    expect(manifest.centerLatLon[0]).toBeCloseTo(PILOT_CENTER.lat, 1);
    expect(manifest.centerLatLon[1]).toBeCloseTo(PILOT_CENTER.lon, 1);

    expect(manifest.tileRange.minX).toBeLessThanOrEqual(manifest.tileRange.maxX);
    expect(manifest.tileRange.minY).toBeLessThanOrEqual(manifest.tileRange.maxY);
    expect(manifest.bounds).toHaveLength(4);
    expect(manifest.bounds.every(isFiniteNumber)).toBe(true);
    expect(manifest.bounds[2]).toBeGreaterThan(manifest.bounds[0]);
    expect(manifest.bounds[3]).toBeGreaterThan(manifest.bounds[1]);

    expect(Array.isArray(manifest.attribution), 'attribution must be an array').toBe(true);
    expect(manifest.attribution.length, 'attribution must not be empty').toBeGreaterThan(0);
    for (const entry of manifest.attribution) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.url).toBe('string');
      expect(entry.url).toMatch(/^https?:\/\//);
      expect(typeof entry.licence).toBe('string');
      expect(entry.licence.length).toBeGreaterThan(0);
    }
    const mentionsOsm = manifest.attribution.some(
      (entry) => /openstreetmap/i.test(entry.name) || /openstreetmap\.org/i.test(entry.url),
    );
    expect(mentionsOsm, 'attribution must credit OpenStreetMap (ODbL)').toBe(true);

    const { counts } = manifest;
    for (const [key, value] of Object.entries(counts)) {
      expect(Number.isInteger(value), `counts.${key} should be an integer`).toBe(true);
      expect(value, `counts.${key} should be non-negative`).toBeGreaterThanOrEqual(0);
    }
    expect(counts.buildings, 'manifest must contain buildings').toBeGreaterThan(0);
    expect(counts.surfaces, 'manifest must contain surfaces').toBeGreaterThan(0);
    expect(counts.roads, 'manifest must contain roads').toBeGreaterThan(0);
    expect(counts.trees, 'manifest must contain trees').toBeGreaterThan(0);
    expect(counts.buildingsWithExplicitHeight).toBeLessThanOrEqual(counts.buildings);
    expect(counts.buildingsWithLevels).toBeLessThanOrEqual(counts.buildings);
    expect(counts.buildingsWithRoofShape).toBeLessThanOrEqual(counts.buildings);
  });

  it('tile index matches the declared grid and covers it completely', () => {
    const manifest = store.manifest;
    if (!manifest) throw new Error('manifest missing');
    const { tileRange, bounds, pilotBounds, tiles } = manifest;
    // `manifest.bounds` is the full tile-grid extent ("total bounds covered by
    // all tiles"); `pilotBounds` (when present) is the requested pilot area and
    // must lie inside it.
    const expectedBounds = [
      tileRange.minX * TILE_SIZE_M,
      tileRange.minY * TILE_SIZE_M,
      (tileRange.maxX + 1) * TILE_SIZE_M,
      (tileRange.maxY + 1) * TILE_SIZE_M,
    ];
    expect(bounds, 'manifest.bounds must equal the tile range extent').toEqual(expectedBounds);

    const pilotHalf = PILOT_SIZE_M / 2;
    const expectedPilotBounds = [-pilotHalf, -pilotHalf, pilotHalf, pilotHalf];
    if (pilotBounds !== undefined) {
      expect(pilotBounds, 'manifest.pilotBounds must be the rendered pilot area').toEqual(expectedPilotBounds);
      expect(pilotBounds[0], 'pilotBounds must lie inside bounds (west)').toBeGreaterThanOrEqual(bounds[0]);
      expect(pilotBounds[1], 'pilotBounds must lie inside bounds (south)').toBeGreaterThanOrEqual(bounds[1]);
      expect(pilotBounds[2], 'pilotBounds must lie inside bounds (east)').toBeLessThanOrEqual(bounds[2]);
      expect(pilotBounds[3], 'pilotBounds must lie inside bounds (north)').toBeLessThanOrEqual(bounds[3]);
    } else {
      // The docs declare pilotBounds optional; when absent the tile bounds must
      // still cover the pilot area.
      expect(bounds[0], 'bounds must cover the pilot area (west)').toBeLessThanOrEqual(expectedPilotBounds[0]);
      expect(bounds[1], 'bounds must cover the pilot area (south)').toBeLessThanOrEqual(expectedPilotBounds[1]);
      expect(bounds[2], 'bounds must cover the pilot area (east)').toBeGreaterThanOrEqual(expectedPilotBounds[2]);
      expect(bounds[3], 'bounds must cover the pilot area (north)').toBeGreaterThanOrEqual(expectedPilotBounds[3]);
    }

    const expectedTileCount =
      (tileRange.maxX - tileRange.minX + 1) * (tileRange.maxY - tileRange.minY + 1);
    expect(tiles.length, 'every tile cell in the declared range must be present').toBe(expectedTileCount);

    const keys = new Set<string>();
    for (const entry of tiles) {
      const label = `${entry.x}_${entry.y}`;
      expect(Number.isInteger(entry.x), `${label}: tile x must be an integer`).toBe(true);
      expect(Number.isInteger(entry.y), `${label}: tile y must be an integer`).toBe(true);
      expect(entry.x).toBeGreaterThanOrEqual(tileRange.minX);
      expect(entry.x).toBeLessThanOrEqual(tileRange.maxX);
      expect(entry.y).toBeGreaterThanOrEqual(tileRange.minY);
      expect(entry.y).toBeLessThanOrEqual(tileRange.maxY);
      expect(entry.file, `${label}: file name must follow tiles/x_y.json`).toBe(`tiles/${entry.x}_${entry.y}.json`);
      expect(entry.bytes, `${label}: bytes must be positive`).toBeGreaterThan(0);
      expect(entry.buildings, `${label}: building count must be non-negative`).toBeGreaterThanOrEqual(0);
      expect(keys.has(entry.file), `duplicate tile entry ${entry.file}`).toBe(false);
      keys.add(entry.file);
    }
  });

  it('every tile file exists, parses, and matches its index entry', () => {
    const manifest = store.manifest;
    if (!manifest) throw new Error('manifest missing');
    for (const { entry, filePath } of store.tiles) {
      expect(existsSync(filePath), `missing tile file ${entry.file}`).toBe(true);
      const size = statSync(filePath).size;
      expect(size, `${entry.file}: manifest bytes=${entry.bytes} but file is ${size} bytes`).toBe(entry.bytes);
    }
    expect(analysis.tileMismatches, formatProblems(analysis.tileMismatches)).toEqual([]);
  });

  it('manifest counts agree with the actual tile payloads', () => {
    const manifest = store.manifest;
    if (!manifest) throw new Error('manifest missing');
    const { counts } = manifest;
    expect(analysis.counts.buildings, 'manifest counts.buildings vs tile payloads').toBe(counts.buildings);
    expect(analysis.counts.surfaces, 'manifest counts.surfaces vs tile payloads').toBe(counts.surfaces);
    expect(analysis.counts.roads, 'manifest counts.roads vs tile payloads').toBe(counts.roads);
    expect(analysis.counts.trees, 'manifest counts.trees vs tile payloads').toBe(counts.trees);
    const entryBuildings = store.tiles.reduce((sum, tile) => sum + tile.entry.buildings, 0);
    expect(entryBuildings, 'sum of tile index building counts').toBe(counts.buildings);
  });

  it('building ids are unique across ALL tiles (exactly one owning tile)', () => {
    expect(
      analysis.duplicateBuildingIds.length,
      `${analysis.duplicateBuildingIds.length} building(s) owned by more than one tile:\n` +
        formatProblems(
          analysis.duplicateBuildingIds.map((dup) => `${dup.id}: ${dup.tiles.join(', ')}`),
        ),
    ).toBe(0);
  });

  it('building ids use the plain FeatureId format (multipolygon parts merged)', () => {
    // src/shared/types.ts: FeatureId = `${osmType[0]}${osmId}`. The pipeline
    // merges multipolygon parts into one BuildingFeature with multiple volumes,
    // so no `${id}_${part}` suffixes may remain in the payload.
    const splitIds = store.tiles.flatMap(({ entry, data }) =>
      data.buildings
        .filter((building) => /^[wr][0-9]+_[0-9]+$/.test(building.id))
        .map((building) => `${entry.x}_${entry.y}/${building.id}`),
    );
    expect(
      splitIds.length,
      `building ids with a multipolygon part suffix: ${formatProblems(splitIds)}`,
    ).toBe(0);
  });

  it('building records are valid (ids, archetypes, heights 2..400 m, volumes)', () => {
    expect(
      analysis.buildingViolations.length,
      `${analysis.buildingViolations.length} building violation(s):\n${formatProblems(analysis.buildingViolations)}`,
    ).toBe(0);
  });

  it('footprints, roads and surfaces are valid rings with >= 3 finite points and no NaN', () => {
    expect(
      analysis.polygonViolations.length,
      `${analysis.polygonViolations.length} polygon violation(s):\n${formatProblems(analysis.polygonViolations)}`,
    ).toBe(0);
  });

  it('crossingBuildingIds never claim ownership and always reference real buildings', () => {
    expect(
      analysis.crossingViolations.length,
      `${analysis.crossingViolations.length} crossing violation(s):\n${formatProblems(analysis.crossingViolations)}`,
    ).toBe(0);
  });

  it('trees have finite positions and plausible size', () => {
    expect(
      analysis.treeViolations.length,
      `${analysis.treeViolations.length} tree violation(s):\n${formatProblems(analysis.treeViolations)}`,
    ).toBe(0);
  });

  it('every tile near the pilot centre contains roads or surfaces', () => {
    const manifest = store.manifest;
    if (!manifest) throw new Error('manifest missing');
    // Pilot centre is local (0, 0) by definition of the projection origin.
    const radius = 300;
    const centreRect: [number, number, number, number] = [-radius, -radius, radius, radius];
    const centralTiles = store.tiles.filter(({ data }) => {
      const [minX, minY, maxX, maxY] = data.bounds;
      return !(maxX < centreRect[0] || minX > centreRect[2] || maxY < centreRect[1] || minY > centreRect[3]);
    });
    expect(centralTiles.length, 'there must be tiles covering the pilot centre').toBeGreaterThan(0);
    const emptyCentralTiles = centralTiles
      .filter(({ data }) => data.roads.length + data.surfaces.length === 0)
      .map(({ entry }) => `${entry.x}_${entry.y}`);
    expect(
      emptyCentralTiles.length,
      `central tiles without roads or surfaces: ${emptyCentralTiles.join(', ')}`,
    ).toBe(0);

    const centralBuildings = centralTiles.reduce((sum, { data }) => sum + data.buildings.length, 0);
    expect(centralBuildings, 'October Square district must have buildings').toBeGreaterThan(0);
  });
});
