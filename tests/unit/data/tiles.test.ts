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
 *  - manifest counts agree with the actual tile payloads (incl. the payload
 *    0.2.0 keys `roadSurfaces` / `roadNetwork` / `junctions` / `crossings`);
 *  - buildings: unique ids across ALL tiles (one owning tile per building),
 *    plain FeatureId format, 2..400 m heights, non-empty valid rings with
 *    >= 3 finite points, sane volume heights, known archetype / roof shape /
 *    height source values, optional `levels` omitted (not null) when unknown;
 *  - legacy roads (rail polygons in payload 0.2.0), surfaces and trees: valid
 *    geometry, no NaN, known enum values;
 *  - payload 0.2.0 normalized roads:
 *      * `roadSurfaces`: kind enum, drivable material always present and known,
 *        valid polygons, boolean `bridge`; a sampling-based probe proves that
 *        drivable pieces of the same bridge layer inside one tile do not
 *        overlap (interior points of the smaller piece), exactly what the
 *        partition rewrite is for. Raised bridge decks may stack over the
 *        ground layer, so the probe groups by `bridge`;
 *      * `roadNetwork`: kind/class enums, positive width, even/finite
 *        centreline with >= 2 points, finite non-negative dash offset, known
 *        material when present; one canonical width per named street
 *        (max-min <= 0.2 m);
 *      * `junctions`: finite position, radius 3..30 m, integer approaches >= 2;
 *      * `crossings`: enums, positive carriageway width, positive span, finite
 *        position/angle, known material when present;
 *      * materials: explicit OSM `surface=sett|cobblestone` ways never read as
 *        asphalt; the stone zone of Karl Marx Street survives normalization
 *        (>= 2 stone network pieces) while its asphalt continuation also does
 *        (>= 1 asphalt piece); at least one stone drivable zone exists;
 *  - crossingBuildingIds point at buildings that are owned elsewhere;
 *  - every tile near the pilot centre carries roads or normalized surfaces.
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
  Polygon,
  Ring,
  RoadMaterial,
  RoadSurfacePiece,
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
  /** crossingBuildingIds ownership/reference problems (payload-independent). */
  crossingOwnershipViolations: string[];
  /** CrossingFeature record problems (payload 0.2.0). */
  crossingViolations: string[];
  /** JunctionFeature record problems (payload 0.2.0). */
  junctionViolations: string[];
  /** RoadSurfacePiece record problems (payload 0.2.0). */
  roadSurfaceViolations: string[];
  /** RoadNetworkPiece record problems (payload 0.2.0). */
  roadNetworkViolations: string[];
  /** Sampling-based drivable-piece overlap probe hits (payload 0.2.0). */
  overlapViolations: string[];
  /** Named streets whose roadNetwork widths disagree by more than 0.2 m. */
  widthViolations: string[];
  /** Material contract problems (stone zone, Karl Marx, surfacing rules). */
  materialViolations: string[];
  treeViolations: string[];
  /** How many bbox-intersecting drivable pairs / interior samples the overlap probe checked. */
  overlapProbe: { pairs: number; samples: number };
  /** Karl Marx Street network pieces by material (payload 0.2.0 material rule). */
  karlMarx: { total: number; stone: number; asphalt: number };
  counts: {
    buildings: number;
    surfaces: number;
    roads: number;
    trees: number;
    roadSurfaces: number;
    roadNetwork: number;
    junctions: number;
    crossings: number;
    drivableByMaterial: Record<string, number>;
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

/** Payload 0.2.0 enums (src/shared/types.ts). */
const ROAD_MATERIALS: ReadonlySet<string> = new Set<RoadMaterial>([
  'asphalt',
  'stone',
  'concrete',
  'unpaved',
]);
const ROAD_SURFACE_KINDS: ReadonlySet<string> = new Set(['drivable', 'paving', 'kerb', 'median']);
const NETWORK_KINDS = ROAD_KINDS;
const CROSSING_KINDS = new Set(['zebra', 'signals', 'unmarked']);

/** Street whose material must keep its explicit OSM stone/cobblestone zone. */
const KARL_MARX_NAME = 'вуліца Карла Маркса';

/** OSM `surface` values that are explicitly stone, so the material must be stone. */
const STONE_SURFACES = new Set(['sett', 'cobblestone', 'cobblestone:flattened', 'unhewn_cobblestone']);

/**
 * Overlap probe tuning. Same-layer surface pieces are a partition, so any
 * positive-area overlap is a bug; the probe looks for a *meaningful* intrusion
 * rather than a shared edge: both the sampled point and the tested polygon must
 * be at least this far from their respective boundaries. 0.5 m is far above
 * the 1 cm payload precision, so it cannot fire on a shared edge.
 */
const OVERLAP_MARGIN_M = 0.5;
const OVERLAP_GRID_PER_AXIS = 7;
const OVERLAP_MAX_SAMPLES = 24;

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

// ---------------------------------------------------------------------------
// local point-in-polygon helpers for the overlap probe (no src/ imports)
// ---------------------------------------------------------------------------

/** Ray-casting point-in-ring test (even-odd rule; boundary is unspecified). */
function pointInRing(point: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > point[1] !== yj > point[1];
    if (crosses && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Point inside the exterior ring and outside every hole. */
function pointInPolygon(point: [number, number], polygon: Polygon): boolean {
  if (!pointInRing(point, polygon[0])) return false;
  for (let index = 1; index < polygon.length; index += 1) {
    if (pointInRing(point, polygon[index])) return false;
  }
  return true;
}

/** Shortest distance from a point to the polygon boundary (all rings). */
function polygonBoundaryDistance(point: [number, number], polygon: Polygon): number {
  let best = Infinity;
  for (const ring of polygon) {
    for (let index = 0; index < ring.length; index += 1) {
      const [ax, ay] = ring[index];
      const [bx, by] = ring[(index + 1) % ring.length];
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      let t = lengthSquared === 0 ? 0 : ((point[0] - ax) * dx + (point[1] - ay) * dy) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
      const distance = Math.hypot(point[0] - (ax + t * dx), point[1] - (ay + t * dy));
      if (distance < best) best = distance;
    }
  }
  return best;
}

type BBox = { minX: number; minY: number; maxX: number; maxY: number; area: number };

function ringBBox(ring: Ring): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, area: (maxX - minX) * (maxY - minY) };
}

function ringCentroid(ring: Ring): [number, number] | null {
  let signedArea = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x0, y0] = ring[index];
    const [x1, y1] = ring[(index + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    signedArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  signedArea /= 2;
  if (Math.abs(signedArea) < 1e-9) return null;
  return [cx / (6 * signedArea), cy / (6 * signedArea)];
}

/**
 * Samples points that are clearly inside the polygon (centroid + a clipped
 * grid), skipping points within OVERLAP_MARGIN_M of any ring edge so shared
 * edges can never look like an overlap.
 */
function sampleInteriorPoints(polygon: Polygon, box: BBox): Array<[number, number]> {
  const candidates: Array<[number, number]> = [];
  const centroid = ringCentroid(polygon[0]);
  if (centroid) candidates.push(centroid);
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  for (let gx = 0; gx < OVERLAP_GRID_PER_AXIS; gx += 1) {
    for (let gy = 0; gy < OVERLAP_GRID_PER_AXIS; gy += 1) {
      candidates.push([
        box.minX + ((gx + 0.5) / OVERLAP_GRID_PER_AXIS) * width,
        box.minY + ((gy + 0.5) / OVERLAP_GRID_PER_AXIS) * height,
      ]);
    }
  }
  const samples: Array<[number, number]> = [];
  for (const candidate of candidates) {
    if (samples.length >= OVERLAP_MAX_SAMPLES) break;
    if (!pointInPolygon(candidate, polygon)) continue;
    if (polygonBoundaryDistance(candidate, polygon) < OVERLAP_MARGIN_M) continue;
    samples.push(candidate);
  }
  return samples;
}

/**
 * Sampling-based non-overlap probe for the drivable partition of one tile.
 *
 * `src/shared/types.ts`: "Pieces of the same kind never overlap." Full polygon
 * boolean operations would duplicate the Python audit; this is an independent,
 * local-maths check that samples the interior of the smaller piece for every
 * bbox-intersecting drivable pair. It expects 0 hits.
 *
 * Two deliberate tolerances, both justified:
 *  - `bridge` decks intentionally stack on top of the ground surface at a
 *    different Y (BRIDGE_RAISE_M = 2.5 m), so only pieces with the SAME bridge
 *    flag are compared with each other;
 *  - a reported hit requires a point >= OVERLAP_MARGIN_M inside BOTH polygons,
 *    so the overlap contains a disc of radius OVERLAP_MARGIN_M (area
 *    ~0.785 m² > the 0.35 m² per-pair grid-snapping tolerance): sub-centimetre
 *    shared-edge slivers can never be reported.
 */
function probeDrivableOverlaps(
  tileName: string,
  pieces: Array<{ piece: RoadSurfacePiece; polygon: Polygon; box: BBox; index: number }>,
  result: DataAnalysis,
): void {
  for (let i = 0; i < pieces.length; i += 1) {
    const a = pieces[i];
    for (let j = i + 1; j < pieces.length; j += 1) {
      const b = pieces[j];
      // Raised bridge decks legitimately overlap the ground layer at a
      // different Y (BRIDGE_RAISE_M = 2.5 m in src/shared/config.ts/types.ts).
      if (Boolean(a.piece.bridge) !== Boolean(b.piece.bridge)) continue;
      const aBox = a.box;
      const bBox = b.box;
      const boxesIntersect =
        aBox.minX <= bBox.maxX && bBox.minX <= aBox.maxX && aBox.minY <= bBox.maxY && bBox.minY <= aBox.maxY;
      if (!boxesIntersect) continue;
      result.overlapProbe.pairs += 1;

      const aIsSmaller = aBox.area <= bBox.area;
      const smaller = aIsSmaller ? a : b;
      const other = aIsSmaller ? b : a;
      for (const point of sampleInteriorPoints(smaller.polygon, smaller.box)) {
        result.overlapProbe.samples += 1;
        if (!pointInPolygon(point, other.polygon)) continue;
        if (polygonBoundaryDistance(point, other.polygon) < OVERLAP_MARGIN_M) continue;
        result.overlapViolations.push(
          `${tileName}: drivable pieces #${a.index} (${String(a.piece.material)}, bridge=${Boolean(
            a.piece.bridge,
          )}) and ` +
            `#${b.index} (${String(b.piece.material)}, bridge=${Boolean(b.piece.bridge)}) overlap at ` +
            `(${point[0].toFixed(2)}, ${point[1].toFixed(2)}) — sampled interior point of the smaller piece is ` +
            `>= ${OVERLAP_MARGIN_M} m inside both polygons`,
        );
        break;
      }
    }
  }
}

function analyse(manifest: TileManifest, tiles: LoadedTile[]): DataAnalysis {
  const result: DataAnalysis = {
    tileMismatches: [],
    duplicateBuildingIds: [],
    buildingViolations: [],
    polygonViolations: [],
    crossingOwnershipViolations: [],
    crossingViolations: [],
    junctionViolations: [],
    roadSurfaceViolations: [],
    roadNetworkViolations: [],
    overlapViolations: [],
    widthViolations: [],
    materialViolations: [],
    treeViolations: [],
    overlapProbe: { pairs: 0, samples: 0 },
    karlMarx: { total: 0, stone: 0, asphalt: 0 },
    counts: {
      buildings: 0,
      surfaces: 0,
      roads: 0,
      trees: 0,
      roadSurfaces: 0,
      roadNetwork: 0,
      junctions: 0,
      crossings: 0,
      drivableByMaterial: {},
      buildingsExplicitHeight: 0,
      buildingsWithLevels: 0,
      buildingsWithRoofShape: 0,
    },
  };

  const owners = new Map<string, string[]>();
  /** name -> widths of all roadNetwork pieces carrying that name. */
  const widthsByName = new Map<string, number[]>();

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
        result.crossingOwnershipViolations.push(
          `${tileName}: crossingBuildingIds lists ${crossingId} but this tile also owns it (double ownership)`,
        );
      }
    }
    const crossingIds = data.crossingBuildingIds ?? [];
    if (new Set(crossingIds).size !== crossingIds.length) {
      result.crossingOwnershipViolations.push(`${tileName}: crossingBuildingIds contains duplicates`);
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

    // ------------------------------------------------------------------
    // payload 0.2.0 — normalized road surface partition
    // ------------------------------------------------------------------
    const roadSurfaces = data.roadSurfaces ?? [];
    const roadNetwork = data.roadNetwork ?? [];
    result.counts.roadSurfaces += roadSurfaces.length;
    result.counts.roadNetwork += roadNetwork.length;

    if (roadNetwork.length > 0 && roadSurfaces.length === 0) {
      result.roadSurfaceViolations.push(
        `${tileName}: has ${roadNetwork.length} roadNetwork piece(s) but no roadSurfaces (the semantic layer must ` +
          'always ride on a rendered surface partition)',
      );
    }

    /** Drivable pieces with a valid polygon, for the overlap probe. */
    const drivableForProbe: Array<{ piece: RoadSurfacePiece; polygon: Polygon; box: BBox; index: number }> = [];

    for (let index = 0; index < roadSurfaces.length; index += 1) {
      const piece = roadSurfaces[index];
      const label = `${tileName}/roadSurface[${index}](${String(piece.kind)})`;
      if (!ROAD_SURFACE_KINDS.has(piece.kind)) {
        result.roadSurfaceViolations.push(`${label}: unknown kind ${String(piece.kind)}`);
      }
      if (piece.kind === 'drivable') {
        if (piece.material === undefined) {
          result.roadSurfaceViolations.push(`${label}: drivable piece has no material`);
        } else if (!ROAD_MATERIALS.has(piece.material)) {
          result.roadSurfaceViolations.push(`${label}: unknown drivable material ${String(piece.material)}`);
        } else {
          result.counts.drivableByMaterial[piece.material] =
            (result.counts.drivableByMaterial[piece.material] ?? 0) + 1;
        }
      } else if (piece.material !== undefined && !ROAD_MATERIALS.has(piece.material)) {
        result.roadSurfaceViolations.push(`${label}: unknown material ${String(piece.material)}`);
      }
      if (piece.bridge !== undefined && typeof piece.bridge !== 'boolean') {
        result.roadSurfaceViolations.push(`${label}: bridge is not a boolean (${String(piece.bridge)})`);
      }
      const problem = polygonProblem(piece.polygon);
      if (problem) {
        result.roadSurfaceViolations.push(`${label}: ${problem}`);
      } else if (piece.kind === 'drivable') {
        drivableForProbe.push({
          piece,
          polygon: piece.polygon as Polygon,
          box: ringBBox(piece.polygon[0] as Ring),
          index,
        });
      }
    }

    probeDrivableOverlaps(tileName, drivableForProbe, result);

    // ------------------------------------------------------------------
    // payload 0.2.0 — semantic road network (markings / crossings source)
    // ------------------------------------------------------------------
    for (let index = 0; index < roadNetwork.length; index += 1) {
      const piece = roadNetwork[index];
      const label = `${tileName}/roadNetwork[${index}](${String(piece.kind)}:${String(piece.class)})`;
      if (!NETWORK_KINDS.has(piece.kind)) {
        result.roadNetworkViolations.push(`${label}: unknown kind ${String(piece.kind)}`);
      }
      if (!ROAD_CLASSES.has(piece.class)) {
        result.roadNetworkViolations.push(`${label}: unknown class ${String(piece.class)}`);
      }
      if (!isFiniteNumber(piece.width) || piece.width <= 0) {
        result.roadNetworkViolations.push(`${label}: width is not a positive finite number (${String(piece.width)})`);
      }
      if (!Array.isArray(piece.centerline)) {
        result.roadNetworkViolations.push(`${label}: centerline is not a flat number[]`);
      } else {
        if (piece.centerline.length < 4 || piece.centerline.length % 2 !== 0) {
          result.roadNetworkViolations.push(
            `${label}: centerline has ${piece.centerline.length} values (must be even and >= 4 for >= 2 points)`,
          );
        }
        const badIndex = piece.centerline.findIndex((value) => !isFiniteNumber(value));
        if (badIndex !== -1) {
          result.roadNetworkViolations.push(
            `${label}: centerline[${badIndex}] is not a finite number (${String(piece.centerline[badIndex])})`,
          );
        }
      }
      if (!isFiniteNumber(piece.centerlineOffset) || piece.centerlineOffset < 0) {
        result.roadNetworkViolations.push(
          `${label}: centerlineOffset is not a finite non-negative number (${String(piece.centerlineOffset)})`,
        );
      }
      if (piece.material !== undefined && !ROAD_MATERIALS.has(piece.material)) {
        result.roadNetworkViolations.push(`${label}: unknown material ${String(piece.material)}`);
      }
      if (piece.surface !== undefined && typeof piece.surface !== 'string') {
        result.roadNetworkViolations.push(`${label}: surface is not a string (${String(piece.surface)})`);
      }
      if (piece.lanes !== undefined && (!Number.isInteger(piece.lanes) || piece.lanes < 1 || piece.lanes > 12)) {
        result.roadNetworkViolations.push(`${label}: implausible lanes ${String(piece.lanes)}`);
      }
      if (piece.oneway !== undefined && typeof piece.oneway !== 'boolean') {
        result.roadNetworkViolations.push(`${label}: oneway is not a boolean (${String(piece.oneway)})`);
      }
      if (piece.bridge !== undefined && typeof piece.bridge !== 'boolean') {
        result.roadNetworkViolations.push(`${label}: bridge is not a boolean (${String(piece.bridge)})`);
      }
      if (piece.name !== undefined && typeof piece.name !== 'string') {
        result.roadNetworkViolations.push(`${label}: name is not a string (${String(piece.name)})`);
      }

      const name = typeof piece.name === 'string' ? piece.name.trim() : '';
      if (name) {
        const widths = widthsByName.get(name) ?? [];
        if (isFiniteNumber(piece.width)) widths.push(piece.width);
        widthsByName.set(name, widths);
      }

      // Explicit OSM stone surfaces must never be rendered as asphalt: the
      // material partition keeps genuine material changes as a shared edge.
      if (piece.surface !== undefined && STONE_SURFACES.has(piece.surface) && piece.material !== 'stone') {
        result.materialViolations.push(
          `${label}: surface=${piece.surface} must map to material 'stone', got ${String(piece.material)}`,
        );
      }

      // Karl Marx Street: the sett/cobblestone section towards Yanka Kupala is
      // a genuine stone zone; the long continuation really is asphalt. The
      // pipeline must preserve both (explicit surface is authoritative).
      if (name === KARL_MARX_NAME) {
        result.karlMarx.total += 1;
        if (piece.material === 'stone') result.karlMarx.stone += 1;
        if (piece.material === 'asphalt') result.karlMarx.asphalt += 1;
      }
    }

    // ------------------------------------------------------------------
    // payload 0.2.0 — junction boxes + pedestrian crossings
    // ------------------------------------------------------------------
    for (let index = 0; index < (data.junctions ?? []).length; index += 1) {
      const junction = data.junctions![index];
      const label = `${tileName}/junction[${index}]`;
      result.counts.junctions += 1;
      if (!isFiniteNumber(junction.x) || !isFiniteNumber(junction.y)) {
        result.junctionViolations.push(`${label}: non-finite position (${String(junction.x)}, ${String(junction.y)})`);
      }
      if (!isFiniteNumber(junction.radius) || junction.radius < 3 || junction.radius > 30) {
        result.junctionViolations.push(
          `${label}: radius ${String(junction.radius)} outside the documented 3..30 m range`,
        );
      }
      if (!Number.isInteger(junction.approaches) || junction.approaches < 2) {
        result.junctionViolations.push(
          `${label}: approaches ${String(junction.approaches)} is not an integer >= 2`,
        );
      }
    }

    for (let index = 0; index < (data.crossings ?? []).length; index += 1) {
      const crossing = data.crossings![index];
      const label = `${tileName}/crossing[${index}](${String(crossing.kind)})`;
      result.counts.crossings += 1;
      if (!CROSSING_KINDS.has(crossing.kind)) {
        result.crossingViolations.push(`${label}: unknown kind ${String(crossing.kind)}`);
      }
      if (!ROAD_CLASSES.has(crossing.roadClass)) {
        result.crossingViolations.push(`${label}: unknown roadClass ${String(crossing.roadClass)}`);
      }
      if (!isFiniteNumber(crossing.x) || !isFiniteNumber(crossing.y)) {
        result.crossingViolations.push(`${label}: non-finite position`);
      }
      if (!isFiniteNumber(crossing.angle)) {
        result.crossingViolations.push(`${label}: angle is not finite (${String(crossing.angle)})`);
      }
      if (!isFiniteNumber(crossing.width) || crossing.width <= 0) {
        result.crossingViolations.push(`${label}: width is not positive (${String(crossing.width)})`);
      }
      if (!isFiniteNumber(crossing.span) || crossing.span <= 0) {
        result.crossingViolations.push(`${label}: span is not positive (${String(crossing.span)})`);
      }
      if (crossing.material !== undefined && !ROAD_MATERIALS.has(crossing.material)) {
        result.crossingViolations.push(`${label}: unknown material ${String(crossing.material)}`);
      }
      if (crossing.oneway !== undefined && typeof crossing.oneway !== 'boolean') {
        result.crossingViolations.push(`${label}: oneway is not a boolean (${String(crossing.oneway)})`);
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
        result.crossingOwnershipViolations.push(
          `${entry.x}_${entry.y}: crossingBuildingIds references unknown building ${crossingId}`,
        );
      }
    }
  }

  // One canonical width per named street (payload 0.2.0 contract).
  for (const [name, widths] of widthsByName) {
    if (widths.length < 2) continue;
    const spread = Math.max(...widths) - Math.min(...widths);
    if (spread > 0.2) {
      result.widthViolations.push(
        `street ${JSON.stringify(name)}: width spread ${spread.toFixed(3)} m > 0.2 m ` +
          `(min ${Math.min(...widths)}, max ${Math.max(...widths)}, ${widths.length} pieces)`,
      );
    }
  }

  // Material sanity: the dataset must contain a genuine stone zone …
  if ((result.counts.drivableByMaterial.stone ?? 0) === 0) {
    result.materialViolations.push('no drivable surface piece with material stone');
  }
  // … and Karl Marx Street keeps its explicit stone + asphalt zones.
  if (result.karlMarx.total === 0) {
    result.materialViolations.push(`no roadNetwork pieces named ${JSON.stringify(KARL_MARX_NAME)}`);
  } else {
    if (result.karlMarx.stone < 2) {
      result.materialViolations.push(
        `${KARL_MARX_NAME}: expected >= 2 stone roadNetwork pieces (sett/cobblestone zone towards Yanka Kupala), ` +
          `found ${result.karlMarx.stone} of ${result.karlMarx.total}`,
      );
    }
    if (result.karlMarx.asphalt < 1) {
      result.materialViolations.push(
        `${KARL_MARX_NAME}: expected >= 1 asphalt roadNetwork piece (the long asphalt continuation), ` +
          `found ${result.karlMarx.asphalt} of ${result.karlMarx.total}`,
      );
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

    // Payload 0.2.0 manifest keys: optional in the type, but when any tile
    // carries the array the declared count must equal the payload sum.
    const optionalCounts = [
      ['roadSurfaces', analysis.counts.roadSurfaces, counts.roadSurfaces],
      ['roadNetwork', analysis.counts.roadNetwork, counts.roadNetwork],
      ['junctions', analysis.counts.junctions, counts.junctions],
      ['crossings', analysis.counts.crossings, counts.crossings],
    ] as const;
    for (const [key, payloadSum, declared] of optionalCounts) {
      expect(
        declared ?? 0,
        `manifest counts.${key} (${String(declared)}) must equal the sum over tile payloads (${payloadSum})` +
          (payloadSum > 0 && declared === undefined ? ' — the 0.2.0 payload requires this count key' : ''),
      ).toBe(payloadSum);
    }
    expect(analysis.counts.roadSurfaces, 'payload 0.2.0 road surface partition is missing').toBeGreaterThan(0);
    expect(analysis.counts.roadNetwork, 'payload 0.2.0 road network layer is missing').toBeGreaterThan(0);
    expect(analysis.counts.junctions, 'payload 0.2.0 junction boxes are missing').toBeGreaterThan(0);
    expect(analysis.counts.crossings, 'payload 0.2.0 pedestrian crossings are missing').toBeGreaterThan(0);
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

  it('footprints, legacy rail roads and surfaces are valid rings with >= 3 finite points and no NaN', () => {
    expect(
      analysis.polygonViolations.length,
      `${analysis.polygonViolations.length} polygon violation(s):\n${formatProblems(analysis.polygonViolations)}`,
    ).toBe(0);
  });

  it('crossingBuildingIds never claim ownership and always reference real buildings', () => {
    expect(
      analysis.crossingOwnershipViolations.length,
      `${analysis.crossingOwnershipViolations.length} crossing ownership violation(s):\n` +
        formatProblems(analysis.crossingOwnershipViolations),
    ).toBe(0);
  });

  it('trees have finite positions and plausible size', () => {
    expect(
      analysis.treeViolations.length,
      `${analysis.treeViolations.length} tree violation(s):\n${formatProblems(analysis.treeViolations)}`,
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // payload 0.2.0 — normalized road layers
  // -------------------------------------------------------------------------

  it('road surface pieces are valid (kinds, materials, rings, bridge flag)', () => {
    expect(
      analysis.roadSurfaceViolations.length,
      `${analysis.roadSurfaceViolations.length} road surface violation(s):\n` +
        formatProblems(analysis.roadSurfaceViolations),
    ).toBe(0);
    // Every drivable piece must carry one of the four materials.
    for (const material of Object.keys(analysis.counts.drivableByMaterial)) {
      expect(ROAD_MATERIALS.has(material), `drivable material ${material} is not in the enum`).toBe(true);
    }
    expect(
      Object.values(analysis.counts.drivableByMaterial).reduce((sum, value) => sum + value, 0),
      'every drivable surface piece must be counted under a known material',
    ).toBeGreaterThan(0);
  });

  it('drivable surface pieces of the same bridge layer do not overlap (sampled interior probe)', () => {
    expect(
      analysis.overlapProbe.pairs,
      'the overlap probe found no bbox-intersecting drivable pair — it would be vacuous',
    ).toBeGreaterThan(0);
    expect(
      analysis.overlapProbe.samples,
      'the overlap probe generated no interior sample points — it would be vacuous',
    ).toBeGreaterThan(0);
    expect(
      analysis.overlapViolations.length,
      `${analysis.overlapViolations.length} drivable same-layer overlap(s) found by sampling ` +
        `(${analysis.overlapProbe.pairs} bbox-intersecting same-bridge pairs, ` +
        `${analysis.overlapProbe.samples} interior samples; bridge decks are compared only with bridge ` +
        'decks — they stack over the ground layer by design):\n' +
        formatProblems(analysis.overlapViolations),
    ).toBe(0);
  });

  it('road network pieces are valid (kind/class/width/centerline/offset/material)', () => {
    expect(
      analysis.roadNetworkViolations.length,
      `${analysis.roadNetworkViolations.length} road network violation(s):\n` +
        formatProblems(analysis.roadNetworkViolations),
    ).toBe(0);
  });

  it('named streets use one canonical width (max-min <= 0.2 m)', () => {
    expect(
      analysis.widthViolations.length,
      `${analysis.widthViolations.length} named street(s) with inconsistent width:\n` +
        formatProblems(analysis.widthViolations),
    ).toBe(0);
  });

  it('road materials are sane (stone zone preserved, Karl Marx keeps stone + asphalt)', () => {
    expect(
      analysis.materialViolations.length,
      `${analysis.materialViolations.length} material violation(s):\n${formatProblems(analysis.materialViolations)}`,
    ).toBe(0);
    const stoneZones = analysis.counts.drivableByMaterial.stone ?? 0;
    expect(stoneZones, 'at least one stone drivable surface zone must exist').toBeGreaterThan(0);
    expect(
      analysis.karlMarx.stone,
      `${KARL_MARX_NAME}: explicit sett/cobblestone zone must survive as material 'stone'`,
    ).toBeGreaterThanOrEqual(2);
    expect(
      analysis.karlMarx.asphalt,
      `${KARL_MARX_NAME}: the genuine asphalt continuation must stay material 'asphalt'`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('junction and crossing features are valid (finite, sane radius/approaches, positive width/span)', () => {
    expect(
      analysis.junctionViolations.length,
      `${analysis.junctionViolations.length} junction violation(s):\n` +
        formatProblems(analysis.junctionViolations),
    ).toBe(0);
    expect(
      analysis.crossingViolations.length,
      `${analysis.crossingViolations.length} crossing violation(s):\n` +
        formatProblems(analysis.crossingViolations),
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
      .filter(
        ({ data }) =>
          data.roads.length + data.surfaces.length + (data.roadSurfaces?.length ?? 0) === 0,
      )
      .map(({ entry }) => `${entry.x}_${entry.y}`);
    expect(
      emptyCentralTiles.length,
      `central tiles without roads, surfaces or normalized road surfaces: ${emptyCentralTiles.join(', ')}`,
    ).toBe(0);

    const centralBuildings = centralTiles.reduce((sum, { data }) => sum + data.buildings.length, 0);
    expect(centralBuildings, 'October Square district must have buildings').toBeGreaterThan(0);
  });
});
