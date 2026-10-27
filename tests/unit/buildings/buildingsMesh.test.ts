/**
 * Unit tests for the procedural building mesh builder.
 *
 * These assert the public contract consumed by the renderer/facade shader:
 * merged indexed geometry, explicit flat normals, correct outward-facing walls
 * (including courtyard holes), facade attributes, deterministic seeds, warnings
 * for degenerate input, and sane triangle counts.
 */

import { describe, expect, it } from 'vitest';
import { buildBuildingsMesh } from '../../../src/city/buildings/buildingsMesh';
import { FACE_KIND, ROOF_SHAPE_ID, ARCHETYPE_ID } from '../../../src/shared/geometry';
import { hexToRgb, pickFacadeColor, pickRoofColor, trimColorFor } from '../../../src/engine/materials/palette';
import { presetFor } from '../../../src/city/facades/presets';
import { seedFromId } from '../../../src/city/buildings/seed';
import { pointInPolygon, type Point2 } from '../../../src/city/buildings/polygon2d';
import type { Polygon } from '../../../src/shared/types';
import {
  courtyardBuilding,
  courtyardPolygon,
  decodeMesh,
  degenerateBuildings,
  footprintCentroidWorld,
  gabledHistoricBuilding,
  lShapedBuilding,
  lShapedRing,
  makeBuilding,
  makeVolume,
  mixedRoofShapes,
  multiVolumeStalinBlock,
  rectRing,
  smallKioskBuilding,
  squarePrismBuilding,
  sumAreaXY,
  type DecodedTriangle,
} from '../../fixtures/buildings';

const WALL_KINDS: readonly number[] = [FACE_KIND.wall, FACE_KIND.ground, FACE_KIND.glass];

function sRGB(hex: string): [number, number, number] {
  const { r, g, b } = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

function expectClose(actual: number, expected: number, tolerance = 1e-4): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function trianglesOfKind(triangles: readonly DecodedTriangle[], kinds: readonly number[]): DecodedTriangle[] {
  return triangles.filter((triangle) => kinds.includes(triangle.faceKind));
}

/** Vertex normals must equal the geometric triangle normal (flat shading). */
function expectFlatShading(triangles: readonly DecodedTriangle[]): void {
  for (const triangle of triangles) {
    for (const vertex of triangle.vertices) {
      const dot =
        vertex.normal[0] * triangle.geometricNormal[0] +
        vertex.normal[1] * triangle.geometricNormal[1] +
        vertex.normal[2] * triangle.geometricNormal[2];
      expect(dot).toBeGreaterThan(0.9999);
    }
  }
}

describe('buildBuildingsMesh — geometry contract', () => {
  it('produces one indexed geometry with consistent attribute arrays', () => {
    const result = buildBuildingsMesh(mixedRoofShapes(), { facadeDetail: true });
    const geometry = result.geometry;
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.triangleOwner.length).toBe(result.triangleCount);
    const index = geometry.getIndex();
    expect(index).not.toBeNull();
    expect(index?.count).toBe(result.triangleCount * 3);
    expect(index?.array).toBeInstanceOf(Uint32Array);
    const count = geometry.getAttribute('position').count;
    for (const name of ['position', 'normal', 'aUV', 'aColor', 'aStyle', 'aFace']) {
      const attribute = geometry.getAttribute(name);
      expect(attribute, name).toBeDefined();
      expect(attribute.count).toBe(count);
    }
    expect(geometry.getAttribute('position').itemSize).toBe(3);
    expect(geometry.getAttribute('normal').itemSize).toBe(3);
    expect(geometry.getAttribute('aUV').itemSize).toBe(2);
    expect(geometry.getAttribute('aColor').itemSize).toBe(3);
    expect(geometry.getAttribute('aStyle').itemSize).toBe(4);
    expect(geometry.getAttribute('aFace').itemSize).toBe(4);
    expect(result.buildingIds.length).toBe(mixedRoofShapes().length);
    expect(result.warnings).toBeDefined();
  });

  it('emits only finite attribute values', () => {
    const result = buildBuildingsMesh(mixedRoofShapes(), { facadeDetail: true });
    for (const name of ['position', 'normal', 'aUV', 'aColor', 'aStyle', 'aFace']) {
      const array = result.geometry.getAttribute(name).array as Float32Array;
      for (let i = 0; i < array.length; i++) {
        expect(Number.isFinite(array[i]), `${name}[${i}] = ${array[i]}`).toBe(true);
      }
    }
    const own = result.geometry.getIndex()?.array as Uint32Array;
    for (let i = 0; i < own.length; i++) expect(Number.isFinite(own[i])).toBe(true);
  });

  it('uses unit normals and flat (non-smoothed) shading', () => {
    const result = buildBuildingsMesh(mixedRoofShapes(), { facadeDetail: true });
    const triangles = decodeMesh(result);
    expectFlatShading(triangles);
    for (const vertex of triangles.flatMap((triangle) => triangle.vertices)) {
      const length = Math.hypot(vertex.normal[0], vertex.normal[1], vertex.normal[2]);
      expectClose(length, 1, 1e-5);
    }
  });

  it('maps every triangle to a valid building owner, in building order', () => {
    const buildings = mixedRoofShapes();
    const result = buildBuildingsMesh(buildings, { facadeDetail: true });
    for (let i = 0; i < result.triangleOwner.length; i++) {
      const owner = result.triangleOwner[i];
      expect(owner).toBeGreaterThanOrEqual(0);
      expect(owner).toBeLessThan(result.buildingIds.length);
    }
    expect(result.buildingIds).toEqual(buildings.map((building) => building.id));
    // Triangle owners are grouped by building (the builder consumes input order).
    let previous = -1;
    for (const owner of result.triangleOwner) {
      expect(owner).toBeGreaterThanOrEqual(previous);
      previous = owner;
    }
  });

  it('returns empty but valid geometry for no buildings', () => {
    const result = buildBuildingsMesh([], { facadeDetail: true });
    expect(result.triangleCount).toBe(0);
    expect(result.triangleOwner.length).toBe(0);
    expect(result.buildingIds).toEqual([]);
    expect(result.geometry.getAttribute('position').count).toBe(0);
    expect(result.geometry.boundingSphere?.radius).toBe(0);
  });
});

describe('buildBuildingsMesh — walls', () => {
  it('square prism: 2 roof + 8 wall triangles without decoration', () => {
    const result = buildBuildingsMesh([squarePrismBuilding()], { facadeDetail: false });
    const triangles = decodeMesh(result);
    expect(result.triangleCount).toBe(10);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.roof)).toHaveLength(2);
    expect(trianglesOfKind(triangles, WALL_KINDS)).toHaveLength(8);
    expect(result.warnings).toEqual([]);
  });

  it('square prism with detail: documented counts (ground split + parapet)', () => {
    // 4 edges * 2 bands * 2 tris = 16 wall/ground + 4 edges * 2 tris parapet
    // + 2 roof cap triangles = 26.
    const result = buildBuildingsMesh([squarePrismBuilding()], { facadeDetail: true });
    const triangles = decodeMesh(result);
    expect(result.triangleCount).toBe(26);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.wall)).toHaveLength(8);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.ground)).toHaveLength(8);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.trim)).toHaveLength(8);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.roof)).toHaveLength(2);
  });

  it('single-storey kiosk uses the ground face kind for the whole wall', () => {
    const result = buildBuildingsMesh([smallKioskBuilding()], { facadeDetail: true });
    const triangles = decodeMesh(result);
    // 4 edges * 2 tris ground + 4 edges * 2 tris parapet + 2 cap.
    expect(result.triangleCount).toBe(18);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.ground)).toHaveLength(8);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.wall)).toHaveLength(0);
  });

  it('wall normals point away from the solid volume', () => {
    const building = squarePrismBuilding();
    const result = buildBuildingsMesh([building], { facadeDetail: true });
    const triangles = decodeMesh(result);
    const [centreX, centreZ] = footprintCentroidWorld(building.volumes[0].footprint);
    const walls = trianglesOfKind(triangles, WALL_KINDS).filter((t) => t.faceKind !== FACE_KIND.roof);
    expect(walls.length).toBeGreaterThan(0);
    for (const triangle of walls) {
      const normal = triangle.vertices[0].normal;
      const dx = triangle.centroid[0] - centreX;
      const dz = triangle.centroid[2] - centreZ;
      expect(normal[0] * dx + normal[2] * dz).toBeGreaterThan(0);
      // Walls are vertical: normal has no vertical component.
      expectClose(normal[1], 0, 1e-6);
    }
  });

  it('wall normals point out of the polygon for concave and courtyard footprints', () => {
    const cases: { polygon: Polygon; name: string }[] = [
      { polygon: [lShapedRing()], name: 'L-shape' },
      { polygon: courtyardPolygon(), name: 'courtyard' },
    ];
    for (const { polygon, name } of cases) {
      const building = makeBuilding([makeVolume(polygon, 0, 15, 'flat', 0)], { id: `w${name.length}` });
      const result = buildBuildingsMesh([building], { facadeDetail: false });
      const triangles = decodeMesh(result);
      const walls = trianglesOfKind(triangles, WALL_KINDS);
      const rings: Point2[][] = polygon.map((ring) => ring.map(([x, y]) => [x, y] as Point2));
      for (const triangle of walls) {
        const normal = triangle.vertices[0].normal;
        // Step just outside the wall along the normal: must leave the solid.
        const x = triangle.centroid[0] + normal[0] * 0.2;
        const y = -triangle.centroid[2] + -normal[2] * 0.2;
        const stillInside = pointInPolygon(rings, x, y);
        expect(stillInside, `${name}: wall triangle ${triangle.index} points into the solid`).toBe(false);
      }
    }
  });

  it('courtyard: 2 wall rings, hole walls face into the courtyard', () => {
    const result = buildBuildingsMesh([courtyardBuilding()], { facadeDetail: false });
    const triangles = decodeMesh(result);
    const walls = trianglesOfKind(triangles, WALL_KINDS);
    // 8 boundary edges (4 exterior + 4 hole) * 2 triangles.
    expect(walls).toHaveLength(16);
    const holeCentreX = 10;
    const holeCentreZ = -10;
    let holeWalls = 0;
    for (const triangle of walls) {
      const x = triangle.centroid[0];
      const y = -triangle.centroid[2];
      const onHoleBoundary =
        x >= 5.9 && x <= 14.1 && y >= 5.9 && y <= 14.1 && (Math.abs(x - 6) < 0.05 || Math.abs(x - 14) < 0.05 || Math.abs(y - 6) < 0.05 || Math.abs(y - 14) < 0.05);
      if (!onHoleBoundary) continue;
      holeWalls++;
      const normal = triangle.vertices[0].normal;
      expect(normal[0] * (holeCentreX - x) + normal[2] * (holeCentreZ - triangle.centroid[2])).toBeGreaterThan(0);
    }
    expect(holeWalls).toBe(8);
  });

  it('aUV is metres, continuous around the ring, with v from the volume base', () => {
    const building = squarePrismBuilding(); // 10x10, 12 m, panel (ground floor 3.0)
    const result = buildBuildingsMesh([building], { facadeDetail: true });
    const triangles = decodeMesh(result);
    const ground = triangles.filter((t) => t.faceKind === FACE_KIND.ground);
    const walls = triangles.filter((t) => t.faceKind === FACE_KIND.wall);
    expect(ground.length).toBeGreaterThan(0);
    expect(walls.length).toBeGreaterThan(0);
    let maxU = 0;
    for (const triangle of [...ground, ...walls]) {
      for (const vertex of triangle.vertices) {
        expect(vertex.uv[0]).toBeGreaterThanOrEqual(0);
        expect(vertex.uv[0]).toBeLessThanOrEqual(40 + 1e-4); // perimeter of the 10x10 square
        maxU = Math.max(maxU, vertex.uv[0]);
      }
    }
    expectClose(maxU, 40, 1e-3);
    for (const triangle of ground) {
      for (const vertex of triangle.vertices) {
        expect(vertex.uv[1]).toBeGreaterThanOrEqual(-1e-6);
        expect(vertex.uv[1]).toBeLessThanOrEqual(3 + 1e-4);
      }
    }
    for (const triangle of walls) {
      for (const vertex of triangle.vertices) {
        expect(vertex.uv[1]).toBeGreaterThanOrEqual(3 - 1e-4);
        expect(vertex.uv[1]).toBeLessThanOrEqual(12 + 1e-4);
      }
    }
  });
});

describe('buildBuildingsMesh — facade attributes', () => {
  it('writes archetype style, flags, trim intensity and seed', () => {
    const building = squarePrismBuilding();
    const seed = seedFromId(building.id);
    const preset = presetFor('panel');
    const result = buildBuildingsMesh([building], { facadeDetail: true });
    for (const triangle of decodeMesh(result)) {
      for (const vertex of triangle.vertices) {
        expect(vertex.style[0]).toBe(ARCHETYPE_ID.panel);
        expectClose(vertex.style[1], preset.floorHeight);
        expectClose(vertex.style[2], preset.groundFloorHeight);
        expectClose(vertex.style[3], seed, 1e-6);
        expect(vertex.face[1]).toBe(preset.flags);
        expectClose(vertex.face[2], Math.min(1, preset.corniceHeight / 1.1));
      }
    }
  });

  it('aFace.w is the detail scale on walls and ROOF_SHAPE_ID on roofs', () => {
    const building = squarePrismBuilding();
    const result = buildBuildingsMesh([building], { facadeDetail: true, detailScale: 0.5 });
    const triangles = decodeMesh(result);
    for (const triangle of triangles) {
      if (triangle.faceKind === FACE_KIND.roof || triangle.faceKind === FACE_KIND.roofRidge) {
        expect(triangle.vertices[0].face[3]).toBe(ROOF_SHAPE_ID.flat);
      } else {
        expectClose(triangle.vertices[0].face[3], 0.5, 1e-6);
      }
    }
  });

  it('writes sRGB base colours (facade colour, roof colour, trim colour)', () => {
    const building = squarePrismBuilding();
    const seed = seedFromId(building.id);
    const baseHex = pickFacadeColor('panel', seed);
    const base = sRGB(baseHex);
    const roof = sRGB(pickRoofColor('flat', seed));
    const trim = sRGB(trimColorFor(baseHex));
    const triangles = decodeMesh(buildBuildingsMesh([building], { facadeDetail: true }));
    for (const triangle of triangles) {
      const expected =
        triangle.faceKind === FACE_KIND.roof
          ? roof
          : triangle.faceKind === FACE_KIND.trim
            ? trim
            : base;
      for (const vertex of triangle.vertices) {
        expectClose(vertex.color[0], expected[0], 2e-3);
        expectClose(vertex.color[1], expected[1], 2e-3);
        expectClose(vertex.color[2], expected[2], 2e-3);
      }
    }
  });

  it('marks elevated building:part volumes with the no-ground sentinel', () => {
    const streetBuilding = squarePrismBuilding({ id: 'w3010' });
    const block = multiVolumeStalinBlock();
    const result = buildBuildingsMesh([streetBuilding, block], { facadeDetail: true });
    const triangles = decodeMesh(result);
    expect(result.triangleCount).toBeGreaterThan(0);

    const streetTriangles = triangles.filter((triangle) => triangle.owner === 0);
    expect(streetTriangles.length).toBeGreaterThan(0);
    expect(streetTriangles[0].vertices[0].style[2]).toBe(presetFor('panel').groundFloorHeight);

    const blockTriangles = triangles.filter((triangle) => triangle.owner === 1);
    expect(blockTriangles.length).toBeGreaterThan(0);
    const sentinel = blockTriangles.filter((triangle) => triangle.vertices[0].style[2] === -1);
    expect(sentinel.length).toBeGreaterThan(0); // elevated tower volume
    expect(blockTriangles.some((triangle) => triangle.vertices[0].style[2] !== -1)).toBe(true);
    // The elevated tower only exists above its minHeight (24 m).
    const lowest = Math.min(...sentinel.flatMap((triangle) => triangle.vertices.map((v) => v.position[1])));
    expect(lowest).toBeCloseTo(24, 3);
  });

  it('is deterministic across runs and varies seed by building id', () => {
    const buildings = mixedRoofShapes();
    const first = buildBuildingsMesh(buildings, { facadeDetail: true });
    const second = buildBuildingsMesh(buildings, { facadeDetail: true });
    const firstPositions = first.geometry.getAttribute('position').array as Float32Array;
    const secondPositions = second.geometry.getAttribute('position').array as Float32Array;
    expect(first.triangleCount).toBe(second.triangleCount);
    expect(Array.from(firstPositions)).toEqual(Array.from(secondPositions));
    expect(Array.from(first.triangleOwner)).toEqual(Array.from(second.triangleOwner));
    const seeds = new Set<number>();
    for (const triangle of decodeMesh(first)) seeds.add(triangle.vertices[0].style[3]);
    // One seed per building, all distinct for these ids.
    expect(seeds.size).toBe(buildings.length);
  });
});

describe('buildBuildingsMesh — LOD and robustness', () => {
  it('facadeDetail=false keeps the triangle count minimal but attributes present', () => {
    const buildings = mixedRoofShapes();
    const low = buildBuildingsMesh(buildings, { facadeDetail: false });
    const high = buildBuildingsMesh(buildings, { facadeDetail: true });
    expect(low.triangleCount).toBeLessThan(high.triangleCount);
    expect(low.geometry.getAttribute('aUV').count).toBeGreaterThan(0);
    expect(low.geometry.getAttribute('aStyle').count).toBeGreaterThan(0);
    expect(low.geometry.getAttribute('aFace').count).toBe(low.geometry.getAttribute('position').count);
  });

  it('skips degenerate volumes with warnings instead of throwing', () => {
    const result = buildBuildingsMesh(degenerateBuildings(), { facadeDetail: true });
    expect(result.triangleCount).toBe(0);
    expect(result.buildingIds).toHaveLength(4);
    expect(result.warnings?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(result.warnings?.join(' ')).toMatch(/degenerate|no volumes|area/i);
  });

  it('filters non-finite footprint points without emitting NaN', () => {
    const ring = rectRing(0, 0, 10, 10);
    ring.splice(2, 0, [Number.NaN, 3]);
    const building = makeBuilding([makeVolume([ring], 0, 10, 'flat', 0)], { id: 'w7001' });
    const result = buildBuildingsMesh([building], { facadeDetail: true });
    expect(result.triangleCount).toBeGreaterThan(0);
    const positions = result.geometry.getAttribute('position').array as Float32Array;
    for (let i = 0; i < positions.length; i++) expect(Number.isFinite(positions[i])).toBe(true);
  });
});
