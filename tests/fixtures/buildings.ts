/**
 * Shared test fixtures + geometry inspection helpers for the building/roof
 * generator tests.
 *
 * Footprints are in LOCAL metres (x east, y north) and CCW for exterior rings,
 * matching what the offline OSM pipeline writes into TileData.
 */

import type {
  Archetype,
  BuildingFeature,
  BuildingStyleVariant,
  BuildingVolume,
  FeatureId,
  Polygon,
  Ring,
  RoofShape,
} from '../../src/shared/types';
import type { BuildingMeshResult } from '../../src/city/buildings/buildingsMesh';
import { pointInPolygon, type Point2 } from '../../src/city/buildings/polygon2d';
import { noiseFromSeed, seedFromId } from '../../src/city/buildings/seed';

// ---------------------------------------------------------------------------
// Polygon construction
// ---------------------------------------------------------------------------

/** Axis aligned rectangle ring, CCW in local metres. */
export function rectRing(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

/** L-shaped (concave) footprint 20x14 with a 8x9 notch cut from the NE corner. */
export function lShapedRing(): Ring {
  return [
    [0, 0],
    [20, 0],
    [20, 5],
    [12, 5],
    [12, 14],
    [0, 14],
  ];
}

/** Square courtyard building: 20x20 exterior with a 8x8 hole in the middle. */
export function courtyardPolygon(): Polygon {
  const outer = rectRing(0, 0, 20, 20);
  // Hole ring wound opposite to the exterior ring (pipeline convention).
  const hole: Ring = [
    [6, 6],
    [6, 14],
    [14, 14],
    [14, 6],
  ];
  return [outer, hole];
}

// ---------------------------------------------------------------------------
// Feature construction
// ---------------------------------------------------------------------------

export function makeVolume(
  footprint: Polygon,
  minHeight: number,
  height: number,
  roofShape: RoofShape = 'flat',
  roofHeight = 0,
  extras: Partial<BuildingVolume> = {},
): BuildingVolume {
  return {
    footprint,
    minHeight,
    height,
    roofShape,
    roofHeight,
    heightSource: 'osm_height',
    ...extras,
  };
}

export interface MakeBuildingOptions {
  id?: FeatureId;
  archetype?: Archetype;
  levels?: number;
  roofShape?: RoofShape;
  name?: string;
  roofDirection?: number;
  /** Offline-assigned style recipe (payload schema 1); omitted = legacy default. */
  styleVariant?: BuildingStyleVariant;
  /** Input volumes recorded when a style profile changed `volumes`. */
  sourceVolumes?: BuildingVolume[];
}

export function makeBuilding(
  volumes: BuildingVolume[],
  options: MakeBuildingOptions = {},
): BuildingFeature {
  const id = options.id ?? 'w1001';
  const numeric = Number.parseInt(id.replace(/\D/g, ''), 10);
  const height = volumes.reduce((max, volume) => Math.max(max, volume.height), 0);
  return {
    id,
    osmType: 'way',
    osmId: Number.isFinite(numeric) ? numeric : 1001,
    archetype: options.archetype ?? 'panel',
    levels: options.levels,
    height,
    roofShape: options.roofShape ?? volumes[0]?.roofShape ?? 'flat',
    volumes,
    tags: {},
    name: options.name,
    ...(options.styleVariant ? { styleVariant: options.styleVariant } : {}),
    ...(options.sourceVolumes ? { sourceVolumes: options.sourceVolumes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Representative buildings
// ---------------------------------------------------------------------------

/** Simple 10x10 flat-roofed prism, 12 m tall. */
export function squarePrismBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  const size = 10;
  const height = 12;
  return makeBuilding(
    [
      makeVolume([rectRing(0, 0, size, size)], 0, height, 'flat', 0),
    ],
    { id: 'w2001', archetype: 'panel', ...options },
  );
}

/** Small single-storey kiosk (whole wall is ground floor). */
export function smallKioskBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [makeVolume([rectRing(0, 0, 4, 3)], 0, 3, 'flat', 0)],
    { id: 'w2002', archetype: 'small', ...options },
  );
}

export function lShapedBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [makeVolume([lShapedRing()], 0, 15, 'flat', 0)],
    { id: 'w2003', archetype: 'office', ...options },
  );
}

export function courtyardBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [makeVolume(courtyardPolygon(), 0, 18, 'flat', 0)],
    { id: 'w2004', archetype: 'stalin', ...options },
  );
}

/** 18x8 historic low-rise with a gabled roof, ridge along the long axis. */
export function gabledHistoricBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [
      makeVolume([rectRing(0, 0, 18, 8)], 0, 9, 'gabled', 3.5, {
        roofDirection: 0,
        heightSource: 'osm_levels',
      }),
    ],
    { id: 'w2005', archetype: 'historic', levels: 3, roofShape: 'gabled', ...options },
  );
}

/** 24x10 hipped roof (Soviet low-rise / civic). */
export function hippedBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [makeVolume([rectRing(0, 0, 24, 10)], 0, 11, 'hipped', 3.2)],
    { id: 'w2006', archetype: 'khrushchev', roofShape: 'hipped', ...options },
  );
}

/** Compact 12x12 pyramidal-roofed civic building. */
export function pyramidalBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [makeVolume([rectRing(0, 0, 12, 12)], 0, 8, 'pyramidal', 3.4)],
    { id: 'w2007', archetype: 'civic', roofShape: 'pyramidal', ...options },
  );
}

/** 20x12 industrial shed with a skillion roof sloping along +X. */
export function skillionBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [makeVolume([rectRing(0, 0, 20, 12)], 0, 7, 'skillion', 2.2, { roofDirection: 0 })],
    { id: 'w2008', archetype: 'industrial', roofShape: 'skillion', ...options },
  );
}

/** 14x10 domed civic building (church-ish proportions). */
export function domeBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [makeVolume([rectRing(0, 0, 14, 10)], 0, 12, 'dome', 5)],
    { id: 'w2009', archetype: 'civic', roofShape: 'dome', ...options },
  );
}

/** 16x12 building whose declared roof shape is "complex". */
export function complexRoofBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [makeVolume([rectRing(0, 0, 16, 12)], 0, 10, 'complex', 2)],
    { id: 'w2010', archetype: 'historic', roofShape: 'complex', ...options },
  );
}

/**
 * Minsk-style Stalinist block along the avenue: long flat-roofed base volume
 * plus an elevated `building:part` tower on one end (vertical volume, not an
 * overlapping duplicate). Roofs are flat with parapets.
 */
export function multiVolumeStalinBlock(options: MakeBuildingOptions = {}): BuildingFeature {
  const base = makeVolume([rectRing(0, 0, 60, 18)], 0, 24, 'flat', 0);
  const tower = makeVolume([rectRing(0, 0, 20, 18)], 24, 31, 'flat', 0, { isPart: true });
  const wing = makeVolume([rectRing(40, 0, 60, 18)], 0, 27, 'flat', 0, { isPart: true });
  // De-overlapped: remove the wing + tower footprints from the base volume.
  base.footprint = [
    [
      [20, 0],
      [40, 0],
      [40, 18],
      [20, 18],
    ],
  ];
  return makeBuilding([base, tower, wing], {
    id: 'w3001',
    archetype: 'stalin',
    levels: 8,
    roofShape: 'flat',
    name: 'Stalinist block',
    ...options,
  });
}

/** 40x12 five-storey Khrushchev block. */
export function khrushchevBlock(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [makeVolume([rectRing(0, 0, 40, 12)], 0, 15, 'flat', 0)],
    { id: 'w3002', archetype: 'khrushchev', levels: 5, roofShape: 'flat', ...options },
  );
}

/** Modern apartment tower with an internal courtyard. */
export function modernTowerWithCourtyard(options: MakeBuildingOptions = {}): BuildingFeature {
  const outer = rectRing(0, 0, 32, 24);
  const hole: Ring = [
    [8, 6],
    [8, 18],
    [24, 18],
    [24, 6],
  ];
  return makeBuilding(
    [makeVolume([outer, hole], 0, 48, 'flat', 0)],
    { id: 'w3003', archetype: 'modern', levels: 16, roofShape: 'flat', ...options },
  );
}

/** Degenerate / malformed volumes that must be skipped with warnings. */
export function degenerateBuildings(): BuildingFeature[] {
  return [
    makeBuilding([makeVolume([rectRing(0, 0, 0, 0)], 0, 10, 'flat', 0)], { id: 'w9001' }),
    makeBuilding([makeVolume([rectRing(0, 0, 10, 10)], 5, 5.2, 'flat', 0)], { id: 'w9002' }),
    makeBuilding([], { id: 'w9003' }),
    makeBuilding([makeVolume([rectRing(0, 0, 0.4, 0.4)], 0, 10, 'flat', 0)], { id: 'w9004' }),
  ];
}

/** Mixed representative set, one of each roof shape. */
export function mixedRoofShapes(): BuildingFeature[] {
  return [
    squarePrismBuilding({ id: 'w4001' }),
    gabledHistoricBuilding({ id: 'w4002' }),
    hippedBuilding({ id: 'w4003' }),
    pyramidalBuilding({ id: 'w4004' }),
    skillionBuilding({ id: 'w4005' }),
    domeBuilding({ id: 'w4006' }),
    complexRoofBuilding({ id: 'w4007' }),
    courtyardBuilding({ id: 'w4008' }),
    lShapedBuilding({ id: 'w4009' }),
  ];
}

/**
 * Deterministic synthetic tile used for the performance smoke test: a grid of
 * apartment blocks of varying size / height / archetype, mostly flat roofs with
 * some pitched historic blocks.
 */
export function syntheticTileBuildings(count = 300): BuildingFeature[] {
  const archetypes: Archetype[] = [
    'panel',
    'khrushchev',
    'stalin',
    'modern',
    'office',
    'historic',
    'industrial',
    'small',
  ];
  const buildings: BuildingFeature[] = [];
  const columns = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const seed = seedFromId(`w${5000 + i}`);
    const col = i % columns;
    const row = Math.floor(i / columns);
    const width = 10 + noiseFromSeed(seed, 1) * 22;
    const depth = 8 + noiseFromSeed(seed, 2) * 14;
    const x = col * 42;
    const y = row * 34;
    const roofShape: RoofShape =
      i % 11 === 0 ? 'gabled' : i % 17 === 0 ? 'hipped' : i % 23 === 0 ? 'skillion' : 'flat';
    const height = 6 + Math.round(noiseFromSeed(seed, 3) * 30);
    const roofHeight =
      roofShape === 'gabled' ? 3 + noiseFromSeed(seed, 4) * 2 : roofShape === 'hipped' ? 2.5 : roofShape === 'skillion' ? 1.8 : 0;
    buildings.push(
      makeBuilding(
        [
          makeVolume(
            [rectRing(x, y, x + width, y + depth)],
            0,
            height,
            roofShape,
            roofHeight,
          ),
        ],
        {
          id: `w${5000 + i}`,
          archetype: archetypes[i % archetypes.length],
          roofShape,
        },
      ),
    );
  }
  return buildings;
}

// ---------------------------------------------------------------------------
// Stadium / grandstand / palace fixtures (Milestone B follow-up)
// ---------------------------------------------------------------------------

/** CCW ellipse ring in local metres (used to fake an arena outline). */
export function ellipseRing(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  count: number,
): Ring {
  const ring: Ring = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    ring.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return ring;
}

/**
 * OSM relation r8414582 (Dynamo Stadium, Minsk): oval arena 206x136 m with two
 * volumes (outer arena 23,106 m² and an inner detail volume 9,605 m²).
 */
export function stadiumBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  const outer = ellipseRing(103, 68, 103, 68, 44);
  const inner = ellipseRing(103, 68, 103 * 0.645, 68 * 0.645, 40);
  const building = makeBuilding(
    [
      makeVolume([outer], 0, 16.8, 'flat', 0),
      makeVolume([inner], 0, 16.8, 'flat', 0),
    ],
    { id: 'r8414582', archetype: 'stadium', roofShape: 'flat', ...options },
  );
  building.osmType = 'relation';
  building.osmId = 8414582;
  building.tags = { building: 'stadium', 'building:levels': '4' };
  return building;
}

/** `building=grandstand` stand: long rectangular rake, blank concrete walls. */
export function grandstandBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  const building = makeBuilding(
    [makeVolume([rectRing(0, 0, 40, 12)], 0, 10, 'flat', 0)],
    { id: 'w9500', archetype: 'civic', roofShape: 'flat', ...options },
  );
  building.tags = { building: 'grandstand' };
  return building;
}

/** The Palace of the Republic (w25327560): a big flat-roofed civic block. */
export function palaceBuilding(options: MakeBuildingOptions = {}): BuildingFeature {
  return makeBuilding(
    [makeVolume([rectRing(0, 0, 30, 20)], 0, 22, 'flat', 0)],
    {
      id: 'w25327560',
      archetype: 'palace',
      levels: 4,
      name: 'Palace of the Republic',
      roofShape: 'flat',
      ...options,
    },
  );
}

// ---------------------------------------------------------------------------
// Geometry inspection
// ---------------------------------------------------------------------------

export interface DecodedVertex {
  position: [number, number, number];
  normal: [number, number, number];
  uv: [number, number];
  color: [number, number, number];
  style: [number, number, number, number];
  face: [number, number, number, number];
}

export interface DecodedTriangle {
  index: number;
  owner: number;
  vertices: [DecodedVertex, DecodedVertex, DecodedVertex];
  /** Face centroid in world space. */
  centroid: [number, number, number];
  /** Unit geometric normal derived from the triangle winding. */
  geometricNormal: [number, number, number];
  /** World space triangle area. */
  area3D: number;
  /** Plan (XZ) projected area — always >= 0. */
  areaXY: number;
  faceKind: number;
  roofShapeId: number;
}

function decodeVertex(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  colors: Float32Array,
  styles: Float32Array,
  faces: Float32Array,
  vertexIndex: number,
): DecodedVertex {
  const p = vertexIndex * 3;
  const q = vertexIndex * 2;
  const r = vertexIndex * 4;
  return {
    position: [positions[p], positions[p + 1], positions[p + 2]],
    normal: [normals[p], normals[p + 1], normals[p + 2]],
    uv: [uvs[q], uvs[q + 1]],
    color: [colors[p], colors[p + 1], colors[p + 2]],
    style: [styles[r], styles[r + 1], styles[r + 2], styles[r + 3]],
    face: [faces[r], faces[r + 1], faces[r + 2], faces[r + 3]],
  };
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function subtract(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Decode a merged building mesh into a triangle list for assertions. */
export function decodeMesh(result: BuildingMeshResult): DecodedTriangle[] {
  const geometry = result.geometry;
  const position = geometry.getAttribute('position') as import('three').BufferAttribute;
  const normal = geometry.getAttribute('normal') as import('three').BufferAttribute;
  const uv = geometry.getAttribute('aUV') as import('three').BufferAttribute;
  const color = geometry.getAttribute('aColor') as import('three').BufferAttribute;
  const style = geometry.getAttribute('aStyle') as import('three').BufferAttribute;
  const face = geometry.getAttribute('aFace') as import('three').BufferAttribute;
  const index = geometry.getIndex();
  const positions = position.array as Float32Array;
  const normals = normal.array as Float32Array;
  const uvs = uv.array as Float32Array;
  const colors = color.array as Float32Array;
  const styles = style.array as Float32Array;
  const faces = face.array as Float32Array;

  const triangles: DecodedTriangle[] = [];
  const triangleCount = index ? index.count / 3 : position.count / 3;
  for (let t = 0; t < triangleCount; t++) {
    const indices: [number, number, number] = index
      ? [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)]
      : [t * 3, t * 3 + 1, t * 3 + 2];
    const vertices = indices.map((vertexIndex) =>
      decodeVertex(positions, normals, uvs, colors, styles, faces, vertexIndex),
    ) as [DecodedVertex, DecodedVertex, DecodedVertex];
    const [a, b, c] = vertices.map((v) => v.position) as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    const ab = subtract(b, a);
    const ac = subtract(c, a);
    const n = cross(ab, ac);
    const area3D = Math.hypot(n[0], n[1], n[2]) / 2;
    const geometricNormal: [number, number, number] =
      area3D > 0
        ? [n[0] / (2 * area3D), n[1] / (2 * area3D), n[2] / (2 * area3D)]
        : [0, 0, 0];
    const centroid: [number, number, number] = [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ];
    triangles.push({
      index: t,
      owner: result.triangleOwner[t],
      vertices,
      centroid,
      geometricNormal,
      area3D,
      areaXY: Math.abs(n[1]) / 2,
      faceKind: vertices[0].face[0],
      roofShapeId: vertices[0].face[3],
    });
  }
  return triangles;
}

/** World (x, h, -y) -> local (x, y) plan coordinates. */
export function worldToLocal2(worldX: number, worldZ: number): [number, number] {
  return [worldX, -worldZ];
}

/** Footprint centroid of a polygon in world space (XZ), on the ground plane. */
export function footprintCentroidWorld(polygon: Polygon): [number, number] {
  const ring = polygon[0];
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j];
    const [x1, y1] = ring[i];
    const crossValue = x0 * y1 - x1 * y0;
    area += crossValue;
    cx += (x0 + x1) * crossValue;
    cy += (y0 + y1) * crossValue;
  }
  area /= 2;
  if (Math.abs(area) < 1e-9) return [ring[0][0], -ring[0][1]];
  return [cx / (6 * area), -(cy / (6 * area))];
}

/** Total plan area of the given triangle subset (m²). */
export function sumAreaXY(triangles: readonly DecodedTriangle[]): number {
  let sum = 0;
  for (const triangle of triangles) sum += triangle.areaXY;
  return sum;
}

/** True when a local (x, y) point lies inside any of the triangles' plan projection. */
export function pointInTrianglePlan(
  triangle: DecodedTriangle,
  localX: number,
  localY: number,
): boolean {
  const [ax, ay] = worldToLocal2(triangle.vertices[0].position[0], triangle.vertices[0].position[2]);
  const [bx, by] = worldToLocal2(triangle.vertices[1].position[0], triangle.vertices[1].position[2]);
  const [cx, cy] = worldToLocal2(triangle.vertices[2].position[0], triangle.vertices[2].position[2]);
  const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(denominator) < 1e-12) return false;
  const w1 = ((by - cy) * (localX - cx) + (cx - bx) * (localY - cy)) / denominator;
  const w2 = ((cy - ay) * (localX - cx) + (ax - cx) * (localY - cy)) / denominator;
  const w3 = 1 - w1 - w2;
  return w1 >= -1e-9 && w2 >= -1e-9 && w3 >= -1e-9;
}

/** Max / min Y coordinate of a triangle subset. */
export function heightRange(triangles: readonly DecodedTriangle[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const triangle of triangles) {
    for (const vertex of triangle.vertices) {
      if (vertex.position[1] < min) min = vertex.position[1];
      if (vertex.position[1] > max) max = vertex.position[1];
    }
  }
  return [min, max];
}

/** World-space AABB of a merged geometry (computes the bounding box if absent). */
export function worldBounds(geometry: {
  computeBoundingBox?: () => void;
  boundingBox?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
}): { min: [number, number, number]; max: [number, number, number] } {
  if (!geometry.boundingBox && typeof geometry.computeBoundingBox === 'function') {
    geometry.computeBoundingBox();
  }
  const box = geometry.boundingBox;
  if (!box) return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

/** Squared distance from a point to a segment in the plan. */
function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return (px - ax) ** 2 + (py - ay) ** 2;
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/**
 * True when a local (x, y) plan point is inside one of the source volumes
 * (exterior ring minus courtyard holes), or within `allowance` metres of an
 * approved exterior projection edge.
 *
 * This is the geometry-preservation oracle for style profiles and detail
 * modules: every emitted vertex must satisfy it (design §8).
 */
export function pointInApprovedPlan(
  x: number,
  y: number,
  volumes: readonly BuildingVolume[],
  allowance = 0.45,
): boolean {
  for (const volume of volumes) {
    const rings = volume.footprint;
    if (!rings || !rings.length) continue;
    if (pointInPolygon([rings[0] as Point2[]], x, y)) {
      let inHole = false;
      for (let i = 1; i < rings.length; i++) {
        if (pointInPolygon([rings[i] as Point2[]], x, y)) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }
    const exterior = rings[0];
    for (let i = 0; i < exterior.length; i++) {
      const a = exterior[i];
      const b = exterior[(i + 1) % exterior.length];
      if (pointSegmentDistanceSq(x, y, a[0], a[1], b[0], b[1]) <= allowance * allowance) return true;
    }
  }
  return false;
}
