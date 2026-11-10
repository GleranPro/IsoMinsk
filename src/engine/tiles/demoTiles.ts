/**
 * Deterministic demo city for development and visual QA.
 *
 * Enabled with `?demo=1`. It exists so the renderer (camera, lighting, shadow,
 * picking, pixel pipeline, LOD) can be exercised end-to-end before — or
 * without — the offline tile pipeline output. It is *not* used when real tile
 * data is present.
 *
 * All polygons are local metres (x east, y north), exterior rings CCW.
 */

import { TILE_SIZE_M } from '../../shared/config';
import { tileBounds } from '../../shared/tileMath';
import type {
  Archetype,
  BuildingFeature,
  RoadPolygon,
  RoofShape,
  SurfacePolygon,
  TileData,
  TileManifest,
  TreeInstance,
} from '../../shared/types';

const DEMO_TILES = [-1, 0, 1];
const BLOCK_M = 128;
const ROAD_WIDTH_M = 14;

interface ArchetypeSpec {
  archetype: Archetype;
  height: number;
  roofShape: RoofShape;
}

const ARCHETYPE_SPECS: ArchetypeSpec[] = [
  { archetype: 'stalin', height: 30, roofShape: 'flat' },
  { archetype: 'stalin', height: 36, roofShape: 'flat' },
  { archetype: 'historic', height: 14, roofShape: 'gabled' },
  { archetype: 'historic', height: 17, roofShape: 'hipped' },
  { archetype: 'khrushchev', height: 15, roofShape: 'flat' },
  { archetype: 'panel', height: 30, roofShape: 'flat' },
  { archetype: 'panel', height: 34, roofShape: 'flat' },
  { archetype: 'modern', height: 48, roofShape: 'flat' },
  { archetype: 'office', height: 26, roofShape: 'flat' },
  { archetype: 'civic', height: 22, roofShape: 'pyramidal' },
  { archetype: 'industrial', height: 9, roofShape: 'gabled' },
  { archetype: 'small', height: 4.5, roofShape: 'skillion' },
];

function hash(n: number): number {
  let value = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  value -= Math.floor(value);
  return value;
}

function ring(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

function makeBuilding(
  id: number,
  spec: ArchetypeSpec,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): BuildingFeature {
  const levels = Math.max(1, Math.round(spec.height / 3));
  return {
    id: `w${900000 + id}`,
    osmType: 'way',
    osmId: 900000 + id,
    name: spec.archetype === 'civic' ? 'House of Culture' : undefined,
    archetype: spec.archetype,
    levels,
    height: spec.height,
    roofShape: spec.roofShape,
    volumes: [
      {
        footprint: [ring(x0, y0, x1, y1)],
        minHeight: 0,
        height: spec.height,
        roofShape: spec.roofShape,
        roofHeight: spec.roofShape === 'flat' ? 0 : Math.min(4, spec.height * 0.12),
        heightSource: 'heuristic',
      },
    ],
    tags: { building: 'yes', 'demo:zone': spec.archetype },
    address: `Demo street ${1 + (id % 40)}`,
  };
}

function makeTiles(): TileData[] {
  const tiles: TileData[] = [];
  let buildingId = 0;
  for (const tileX of DEMO_TILES) {
    for (const tileY of DEMO_TILES) {
      const bounds = tileBounds(tileX, tileY, TILE_SIZE_M);
      const buildings: BuildingFeature[] = [];
      const roads: RoadPolygon[] = [];
      const surfaces: SurfacePolygon[] = [];
      const trees: TreeInstance[] = [];

      // Buildings on a 128 m block grid; the outer ring of each tile is road.
      const blocks = [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
        [0, 2],
        [1, 2],
        [2, 2],
        [3, 2],
        [0, 3],
        [1, 3],
        [2, 3],
        [3, 3],
      ];
      for (const [bx, by] of blocks) {
        const cellX = bounds[0] + bx * BLOCK_M;
        const cellY = bounds[1] + by * BLOCK_M;
        const random = hash(tileX * 131 + tileY * 17 + bx * 7 + by * 3);
        const built = random > 0.14;
        if (!built) {
          // Courtyard / lawn: grass surface and a couple of trees.
          surfaces.push({
            kind: random > 0.06 ? 'grass' : 'park',
            polygon: [ring(cellX + 8, cellY + 8, cellX + BLOCK_M - 8, cellY + BLOCK_M - 8)],
          });
          const treeCount = 2 + Math.floor(hash(random * 91) * 3);
          for (let t = 0; t < treeCount; t += 1) {
            trees.push({
              x: cellX + 20 + hash(random * 17 + t) * (BLOCK_M - 40),
              y: cellY + 20 + hash(random * 29 + t) * (BLOCK_M - 40),
              height: 6 + hash(random * 41 + t) * 4,
              radius: 3.4 + hash(random * 53 + t) * 1.6,
              variation: hash(random * 67 + t),
              mapped: false,
            });
          }
          continue;
        }

        // Two to four footprints per block, inset from the street grid.
        const inset = ROAD_WIDTH_M * 0.5 + 7;
        const splitX = hash(random * 13) > 0.5;
        const pieces = splitX
          ? [
              [0.08, 0.8, 0.12, 0.42],
              [0.08, 0.8, 0.55, 0.88],
            ]
          : [
              [0.08, 0.44, 0.12, 0.88],
              [0.52, 0.88, 0.12, 0.88],
            ];
        for (const [fx0, fx1, fy0, fy1] of pieces) {
          const x0 = cellX + inset + (BLOCK_M - 2 * inset) * fx0;
          const x1 = cellX + inset + (BLOCK_M - 2 * inset) * fx1;
          const y0 = cellY + inset + (BLOCK_M - 2 * inset) * fy0;
          const y1 = cellY + inset + (BLOCK_M - 2 * inset) * fy1;
          const spec = ARCHETYPE_SPECS[Math.floor(hash(random * 100 + buildingId) * ARCHETYPE_SPECS.length) % ARCHETYPE_SPECS.length];
          const heightJitter = 0.82 + hash(random * 7 + buildingId) * 0.5;
          buildings.push(
            makeBuilding(
              buildingId,
              { ...spec, height: Math.round(spec.height * heightJitter * 10) / 10 },
              x0,
              y0,
              x1,
              y1,
            ),
          );
          buildingId += 1;
        }

        // Street trees in the gap between the block edge and its buildings.
        for (let t = 0; t < 3; t += 1) {
          trees.push({
            x: cellX + 10 + t * 14,
            y: cellY + 6,
            height: 6.5 + hash(random * 31 + t) * 3,
            radius: 3.2 + hash(random * 47 + t) * 1.4,
            variation: hash(random * 59 + t),
            mapped: false,
          });
        }
      }

      // Road grid inside the tile: lines are drawn only along the south and
      // west edges plus interior lines, so adjacent tiles never draw the same
      // coplanar strip twice (no z-fighting at tile borders).
      const [minX, minY, maxX, maxY] = bounds;
      for (let i = 0; i < 4; i += 1) {
        const y = minY + i * BLOCK_M;
        roads.push({
          kind: 'road',
          class: i % 2 === 0 ? 'secondary' : 'residential',
          polygon: [ring(minX, y - ROAD_WIDTH_M / 2, maxX, y + ROAD_WIDTH_M / 2)],
          width: ROAD_WIDTH_M,
        });
        const x = minX + i * BLOCK_M;
        roads.push({
          kind: 'road',
          class: i % 2 === 0 ? 'secondary' : 'residential',
          polygon: [ring(x - ROAD_WIDTH_M / 2, minY, x + ROAD_WIDTH_M / 2, maxY)],
          width: ROAD_WIDTH_M,
        });
      }

      // A plaza on the centre tile, water on the north-east tile edge.
      if (tileX === 0 && tileY === 0) {
        surfaces.push({
          kind: 'plaza',
          polygon: [ring(-80, -80, 80, 80)],
        });
      }
      if (tileX === 1 && tileY === 1) {
        surfaces.push({
          kind: 'park',
          polygon: [ring(minX + 40, minY + 40, maxX - 40, maxY - 120)],
        });
      }

      tiles.push({
        tileX,
        tileY,
        bounds,
        buildings,
        surfaces,
        roads,
        trees,
      });
    }
  }
  return tiles;
}

let cachedTiles: TileData[] | null = null;

export function createDemoTiles(): TileData[] {
  if (!cachedTiles) cachedTiles = makeTiles();
  return cachedTiles;
}

export function createDemoManifest(tiles: TileData[] = createDemoTiles()): TileManifest {
  const minX = Math.min(...tiles.map(t => t.bounds[0]));
  const minY = Math.min(...tiles.map(t => t.bounds[1]));
  const maxX = Math.max(...tiles.map(t => t.bounds[2]));
  const maxY = Math.max(...tiles.map(t => t.bounds[3]));
  const buildingCount = tiles.reduce((sum, tile) => sum + tile.buildings.length, 0);
  return {
    version: 'demo',
    generatedAt: new Date().toISOString(),
    epsg: 32635,
    originUtm: [0, 0],
    centerLatLon: [53.9022, 27.561],
    tileSize: TILE_SIZE_M,
    tileRange: { minX: Math.min(...tiles.map(t => t.tileX)), minY: Math.min(...tiles.map(t => t.tileY)),
      maxX: Math.max(...tiles.map(t => t.tileX)), maxY: Math.max(...tiles.map(t => t.tileY)) },
    bounds: [minX, minY, maxX, maxY],
    tiles: tiles.map((tile) => ({
      x: tile.tileX,
      y: tile.tileY,
      file: '',
      buildings: tile.buildings.length,
      bytes: 0,
    })),
    counts: {
      buildings: buildingCount,
      buildingsWithExplicitHeight: 0,
      buildingsWithLevels: buildingCount,
      buildingsWithRoofShape: buildingCount,
      surfaces: tiles.reduce((sum, tile) => sum + tile.surfaces.length, 0),
      roads: tiles.reduce((sum, tile) => sum + tile.roads.length, 0),
      trees: tiles.reduce((sum, tile) => sum + tile.trees.length, 0),
    },
    attribution: [
      {
        name: 'Synthetic demo data',
        url: 'https://www.openstreetmap.org/copyright',
        licence: 'generated for development only',
        note: 'Enable the real map by removing ?demo=1 once public/data/tiles exists',
      },
    ],
  };
}
