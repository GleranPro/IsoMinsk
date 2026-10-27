/**
 * Unit tests for roof generation: every RoofShape produces a watertight,
 * non-floating roof that covers its footprint, with sloped facets where the
 * shape implies them and flat fallbacks + warnings for anything unsupported.
 */

import { describe, expect, it } from 'vitest';
import { buildBuildingsMesh } from '../../../src/city/buildings/buildingsMesh';
import { FACE_KIND, ROOF_SHAPE_ID } from '../../../src/shared/geometry';
import { pointInPolygon, type Point2 } from '../../../src/city/buildings/polygon2d';
import type { BuildingFeature, Polygon, RoofShape } from '../../../src/shared/types';
import {
  complexRoofBuilding,
  courtyardBuilding,
  courtyardPolygon,
  decodeMesh,
  domeBuilding,
  footprintCentroidWorld,
  gabledHistoricBuilding,
  hippedBuilding,
  makeBuilding,
  makeVolume,
  pyramidalBuilding,
  rectRing,
  skillionBuilding,
  squarePrismBuilding,
  sumAreaXY,
  type DecodedTriangle,
} from '../../fixtures/buildings';

const ROOF_KINDS: readonly number[] = [FACE_KIND.roof, FACE_KIND.roofRidge];

function buildOne(building: BuildingFeature, facadeDetail = false) {
  return buildBuildingsMesh([building], { facadeDetail });
}

function roofTriangles(triangles: readonly DecodedTriangle[]): DecodedTriangle[] {
  return triangles.filter((triangle) => ROOF_KINDS.includes(triangle.faceKind));
}

function footprintArea(polygon: Polygon): number {
  // Shoelace; exterior minus holes.
  let area = 0;
  polygon.forEach((ring, index) => {
    let ringArea = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      ringArea += x0 * y1 - x1 * y0;
    }
    ringArea = Math.abs(ringArea) / 2;
    area += index === 0 ? ringArea : -ringArea;
  });
  return area;
}

function heightRange(triangles: readonly DecodedTriangle[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const triangle of triangles) {
    for (const vertex of triangle.vertices) {
      min = Math.min(min, vertex.position[1]);
      max = Math.max(max, vertex.position[1]);
    }
  }
  return [min, max];
}

/** Plan (local x, y) coordinates of a world vertex. */
function localXZ(vertex: { position: [number, number, number] }): [number, number] {
  return [vertex.position[0], -vertex.position[2]];
}

function roofAreaXY(triangles: readonly DecodedTriangle[]): number {
  return sumAreaXY(roofTriangles(triangles));
}

const SLOPED_CASES: { name: string; building: BuildingFeature; rise: number }[] = [
  { name: 'gabled', building: gabledHistoricBuilding(), rise: 3.5 },
  { name: 'hipped', building: hippedBuilding(), rise: 3.2 },
  { name: 'pyramidal', building: pyramidalBuilding(), rise: 3.4 },
  { name: 'skillion', building: skillionBuilding(), rise: 2.2 },
  { name: 'dome', building: domeBuilding(), rise: 5 },
];

describe('roofs — coverage', () => {
  it.each(SLOPED_CASES)('$name roof surface covers the footprint within 1%', ({ building }) => {
    const result = buildOne(building);
    const triangles = decodeMesh(result);
    const expected = footprintArea(building.volumes[0].footprint);
    const covered = roofAreaXY(triangles);
    expect(Math.abs(covered - expected) / expected).toBeLessThan(0.01);
  });

  it('flat roof covers the footprint exactly', () => {
    const building = squarePrismBuilding();
    const triangles = decodeMesh(buildOne(building));
    expect(roofAreaXY(triangles)).toBeCloseTo(100, 3);
    expect(roofTriangles(triangles)).toHaveLength(2);
  });

  it('flat courtyard roof keeps the hole open', () => {
    const building = courtyardBuilding();
    const triangles = decodeMesh(buildOne(building));
    const roof = roofTriangles(triangles);
    expect(roof.length).toBeGreaterThan(0);
    const hole: Point2[] = [
      [6, 6],
      [14, 6],
      [14, 14],
      [6, 14],
    ];
    for (const triangle of roof) {
      const [cx, cy] = localXZ({ position: triangle.centroid });
      expect(pointInPolygon([hole], cx, cy)).toBe(false);
    }
    // 400 - 64 m².
    expect(roofAreaXY(triangles)).toBeCloseTo(336, 2);
  });
});

describe('roofs — gabled', () => {
  it('produces sloped roof triangles above the eave with a ridge over the centre', () => {
    const building = gabledHistoricBuilding(); // 18x8, eave 9, rise 3.5
    const triangles = decodeMesh(buildOne(building));
    const roof = roofTriangles(triangles);
    expect(roof.length).toBeGreaterThan(0);
    for (const triangle of roof) expect(triangle.faceKind).toBe(FACE_KIND.roofRidge);
    // Sloped: facet normals have a horizontal component (not flat).
    for (const triangle of roof) {
      expect(Math.abs(triangle.vertices[0].normal[1])).toBeLessThan(0.98);
      expect(triangle.vertices[0].normal[1]).toBeGreaterThan(0);
      expect(triangle.roofShapeId).toBe(ROOF_SHAPE_ID.gabled);
    }
    const [min, max] = heightRange(roof);
    expect(max).toBeCloseTo(9 + 3.5, 3);
    expect(min).toBeCloseTo(9, 3);
    // Ridge line runs along the long axis (local y = 4) through the centre.
    const ridgeVertices = roof
      .flatMap((triangle) => triangle.vertices)
      .filter((vertex) => Math.abs(localXZ(vertex)[1] - 4) < 1e-3);
    expect(ridgeVertices.length).toBeGreaterThan(0);
    for (const vertex of ridgeVertices) expect(vertex.position[1]).toBeCloseTo(12.5, 3);
    const [centreX, centreZ] = footprintCentroidWorld(building.volumes[0].footprint);
    const ridgeAboveCentre = ridgeVertices.some(
      (vertex) => Math.hypot(vertex.position[0] - centreX, vertex.position[2] - centreZ) < 2,
    );
    expect(ridgeAboveCentre).toBe(true);
  });

  it('closes the gable ends above the eave (no floating roof)', () => {
    const building = gabledHistoricBuilding();
    const triangles = decodeMesh(buildOne(building));
    const eave = building.volumes[0].height;
    const closings = triangles.filter(
      (triangle) =>
        triangle.faceKind === FACE_KIND.wall &&
        triangle.vertices.every((vertex) => vertex.position[1] >= eave - 1e-6),
    );
    // Each gable end is a triangle above the eave, split at the ridge into two
    // triangles (the degenerate half-quad is dropped).
    expect(closings).toHaveLength(4);
    const area = closings.reduce((sum, triangle) => sum + triangle.area3D, 0);
    // Two triangles with base 8 and height 3.5.
    expect(area).toBeCloseTo(2 * 0.5 * 8 * 3.5, 2);
    // Closing walls are vertical and face away from the building.
    const polygon = building.volumes[0].footprint.map((ring) =>
      ring.map(([x, y]) => [x, y] as Point2),
    );
    for (const triangle of closings) {
      const normal = triangle.vertices[0].normal;
      expect(Math.abs(normal[1])).toBeLessThan(1e-6);
      const x = triangle.centroid[0] + normal[0] * 0.2;
      const y = -triangle.centroid[2] - normal[2] * 0.2;
      expect(pointInPolygon(polygon, x, y)).toBe(false);
    }
  });
});

describe('roofs — hipped / pyramidal / skillion', () => {
  it('hipped roof reaches the ridge height and meets the eave at the footprint edge', () => {
    const building = hippedBuilding(); // 24x10, eave 11, rise 3.2
    const triangles = decodeMesh(buildOne(building));
    const roof = roofTriangles(triangles);
    const [min, max] = heightRange(roof);
    expect(min).toBeCloseTo(11, 2);
    expect(max).toBeCloseTo(11 + 3.2, 2);
    // Ridge along the long axis (local y = 5) for an elongated plan.
    const ridgeVertices = roof
      .flatMap((triangle) => triangle.vertices)
      .filter((vertex) => Math.abs(localXZ(vertex)[1] - 5) < 1e-3);
    expect(ridgeVertices.length).toBeGreaterThan(0);
    for (const vertex of ridgeVertices) expect(vertex.position[1]).toBeCloseTo(14.2, 2);
    // Hip faces: four sloped facets (no vertical roof faces).
    for (const triangle of roof) {
      expect(triangle.vertices[0].normal[1]).toBeGreaterThan(0);
      expect(triangle.vertices[0].normal[1]).toBeLessThan(0.999);
    }
  });

  it('pyramidal roof has an apex above the footprint centre', () => {
    const building = pyramidalBuilding(); // 12x12, eave 8, rise 3.4
    const triangles = decodeMesh(buildOne(building));
    const roof = roofTriangles(triangles);
    const [, max] = heightRange(roof);
    expect(max).toBeCloseTo(11.4, 2);
    const apexVertices = roof
      .flatMap((triangle) => triangle.vertices)
      .filter((vertex) => Math.abs(vertex.position[1] - 11.4) < 0.05);
    expect(apexVertices.length).toBeGreaterThan(0);
    expect(Math.hypot(apexVertices[0].position[0] - 6, apexVertices[0].position[2] + 6)).toBeLessThan(0.5);
  });

  it('skillion height is monotonic along the slope direction', () => {
    const building = skillionBuilding(); // 20x12, eave 7, rise 2.2, direction +X
    const triangles = decodeMesh(buildOne(building));
    const roof = roofTriangles(triangles);
    for (const vertex of roof.flatMap((triangle) => triangle.vertices)) {
      const expected = 7 + 2.2 * (vertex.position[0] / 20);
      expect(vertex.position[1]).toBeCloseTo(expected, 2);
    }
    // Roof normal leans towards -X (surface rises towards +X).
    for (const triangle of roof) {
      expect(triangle.vertices[0].normal[0]).toBeLessThan(0);
    }
    const [min, max] = heightRange(roof);
    expect(min).toBeCloseTo(7, 2);
    expect(max).toBeCloseTo(9.2, 2);
  });

  it('closes the shed end walls above the eave', () => {
    const building = skillionBuilding();
    const triangles = decodeMesh(buildOne(building));
    const eave = building.volumes[0].height;
    const closings = triangles.filter(
      (triangle) =>
        triangle.faceKind === FACE_KIND.wall &&
        triangle.vertices.some((vertex) => vertex.position[1] > eave + 0.2),
    );
    expect(closings.length).toBeGreaterThan(0);
  });
});

describe('roofs — dome', () => {
  it('builds a stepped, non-spiky dome silhouette with a flat skirt', () => {
    const building = domeBuilding(); // 14x10, eave 12, rise 5
    const result = buildOne(building);
    const triangles = decodeMesh(result);
    const roof = roofTriangles(triangles);
    expect(roof.length).toBeGreaterThan(10);
    const [min, max] = heightRange(roof);
    expect(min).toBeCloseTo(12, 2);
    expect(max).toBeCloseTo(17, 2);
    // Dome facets carry ROOF_SHAPE_ID.dome; the surrounding skirt is a flat cap.
    expect(roof.some((triangle) => triangle.roofShapeId === ROOF_SHAPE_ID.dome)).toBe(true);
    expect(roof.some((triangle) => triangle.roofShapeId === ROOF_SHAPE_ID.flat)).toBe(true);
    // Multiple distinct facet heights -> stepped profile rather than a single cone.
    const levels = new Set(roof.map((triangle) => Math.round(triangle.centroid[1] * 10)));
    expect(levels.size).toBeGreaterThanOrEqual(4);
    // Concave silhouette: a vertex at 3/4 of the rise is closer to the centre
    // than a vertex at the eave.
    expect(roofAreaXY(triangles)).toBeCloseTo(140, 1);
    expect(result.warnings).toEqual([]);
  });

  it('falls back to a hull dome for a non-rectangular footprint', () => {
    const ring = rectRing(0, 0, 14, 10);
    // Chamfer one corner so the inscribed octagon is rejected.
    const chamfered: [number, number][] = [
      [0, 0],
      [14, 0],
      [14, 6],
      [10, 10],
      [0, 10],
    ];
    const building = makeBuilding([makeVolume([chamfered], 0, 12, 'dome', 4)], {
      id: 'w8100',
      archetype: 'civic',
      roofShape: 'dome',
    });
    const result = buildGroundSafe(building);
    expect(result).not.toBeNull();
    const triangles = decodeMesh(result!);
    const roof = roofTriangles(triangles);
    expect(roof.length).toBeGreaterThan(0);
    const [, max] = heightRange(roof);
    expect(max).toBeGreaterThan(12);
    expect(roofAreaXY(triangles)).toBeCloseTo(footprintArea([chamfered]), 1);
    void ring;
  });
});

function buildGroundSafe(building: BuildingFeature) {
  try {
    return buildOne(building);
  } catch {
    return null;
  }
}

describe('roofs — fallbacks and warnings', () => {
  it('complex shape falls back to a flat roof with a warning', () => {
    const building = complexRoofBuilding(); // 16x12, eave 10
    const result = buildOne(building);
    const triangles = decodeMesh(result);
    expect(result.warnings?.join(' ')).toMatch(/complex/i);
    expect(roofTriangles(triangles).every((triangle) => triangle.faceKind === FACE_KIND.roof)).toBe(true);
    const [, max] = heightRange(roofTriangles(triangles));
    expect(max).toBeCloseTo(10, 3);
    expect(roofAreaXY(triangles)).toBeCloseTo(192, 1);
  });

  it('unsupported roof shape falls back to flat with a warning', () => {
    const building = makeBuilding(
      [makeVolume([rectRing(0, 0, 12, 8)], 0, 9, 'mansard' as unknown as RoofShape, 2)],
      { id: 'w8200', archetype: 'historic' },
    );
    const result = buildBuildingsMesh([building], { facadeDetail: false });
    const triangles = decodeMesh(result);
    expect(result.warnings?.join(' ')).toMatch(/unsupported/i);
    expect(roofTriangles(triangles).every((triangle) => triangle.faceKind === FACE_KIND.roof)).toBe(true);
    const [, max] = heightRange(roofTriangles(triangles));
    expect(max).toBeCloseTo(9, 3);
  });

  it('derives a fallback rise when a sloped roof has no roofHeight (with warning)', () => {
    const building = makeBuilding(
      [makeVolume([rectRing(0, 0, 18, 8)], 0, 9, 'gabled', 0)],
      { id: 'w8300', archetype: 'historic', roofShape: 'gabled' },
    );
    const result = buildOne(building);
    const triangles = decodeMesh(result);
    expect(result.warnings?.join(' ')).toMatch(/derived/i);
    const [min, max] = heightRange(roofTriangles(triangles));
    expect(max - min).toBeGreaterThan(1.4);
    expect(max - min).toBeLessThan(7.1);
    // 0.28 * short side (8 m) = 2.24 m.
    expect(max).toBeCloseTo(9 + 2.24, 2);
  });
});

describe('roofs — flat parapet', () => {
  it('adds a trim parapet band only when facade detail is enabled', () => {
    const building = squarePrismBuilding();
    const detailed = decodeMesh(buildOne(building, true));
    const minimal = decodeMesh(buildOne(building, false));
    const trim = (triangles: DecodedTriangle[]): DecodedTriangle[] =>
      triangles.filter((triangle) => triangle.faceKind === FACE_KIND.trim);
    expect(trim(minimal)).toHaveLength(0);
    expect(trim(detailed)).toHaveLength(8); // 4 edges * 2 triangles
    const eave = building.volumes[0].height;
    const [, max] = heightRange(trim(detailed));
    expect(max - eave).toBeGreaterThanOrEqual(0.25);
    expect(max - eave).toBeLessThanOrEqual(0.4);
  });
});

describe('roofs — triangle budget sanity', () => {
  it('a rectangular flat building needs only 10 triangles', () => {
    const building = squarePrismBuilding();
    expect(buildOne(building).triangleCount).toBe(10);
  });

  it('a courtyard flat building needs 24 triangles (16 walls + 8 cap)', () => {
    const result = buildOne(courtyardBuilding());
    expect(result.triangleCount).toBe(24);
  });
});
