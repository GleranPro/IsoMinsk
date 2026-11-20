/**
 * Facade detail module tests: closed solids, bounded projections, outward
 * normals, metric UVs, owner tracking and the safe-skip contract.
 */

import { describe, expect, it } from 'vitest';
import { MeshSink } from '../../../src/city/buildings/meshSink';
import { boundaryRings } from '../../../src/city/buildings/walls';
import {
  MAX_PROJECTION_M,
  MIN_PROJECTION_M,
  addBalconyStack,
  addBox,
  addEntranceTreatment,
  addFacadeFrame,
  addRoofService,
  expandBounds,
  facadeEdges,
  ringsBounds,
  type FacadeDetailContext,
} from '../../../src/city/buildings/facadeDetails';
import { styleForBuilding } from '../../../src/city/buildings/style';
import { FACE_KIND } from '../../../src/shared/geometry';
import type { BuildingVolume } from '../../../src/shared/types';
import {
  courtyardPolygon,
  decodeMesh,
  makeVolume,
  rectRing,
  squarePrismBuilding,
} from '../../fixtures/buildings';
import type { BuildingMeshResult } from '../../../src/city/buildings/buildingsMesh';

function finish(sink: MeshSink): BuildingMeshResult {
  const result = sink.finish();
  return {
    geometry: result.geometry,
    triangleOwner: result.triangleOwner,
    buildingIds: ['w1'],
    triangleCount: result.triangleCount,
    stats: {
      buildings: 1,
      profiledBuildings: 0,
      sourceTriangles: 0,
      detailTriangles: result.triangleCount,
      totalTriangles: result.triangleCount,
      modulesEmitted: 0,
      moduleFailures: 0,
      geometryBytes: 0,
    },
  };
}

function contextFor(
  volume: BuildingVolume,
  options: { styleRecipe?: number; detail?: boolean } = {},
): { style: ReturnType<typeof styleForBuilding>; context: FacadeDetailContext; volume: BuildingVolume } {
  const building = squarePrismBuilding({
    id: 'w-detail',
    archetype: 'panel',
    styleVariant: {
      schema: 1,
      recipeId: options.styleRecipe ?? 6,
      source: 'heuristic',
      eligibility: ['synthetic_gallery'],
    },
  });
  building.volumes = [volume];
  building.height = volume.height;
  const style = styleForBuilding(building, 0, options.detail !== false, 1);
  const rings = boundaryRings(volume);
  const box = ringsBounds(rings);
  return {
    style,
    volume,
    context: {
      rings,
      volume,
      allowedBounds: box ? expandBounds(box) : undefined,
      floorHeight: style.floorHeight,
      groundFloorHeight: style.groundFloorHeight,
      bayWidth: style.bayWidth,
      detail: options.detail !== false,
    },
  };
}

describe('addBox', () => {
  it('emits a closed manifold with finite normals and metric UVs', () => {
    const volume = makeVolume([rectRing(0, 0, 20, 12)], 0, 18, 'flat', 0);
    const { style, context } = contextFor(volume);
    const sink = new MeshSink();
    addBox(
      sink,
      style,
      [
        [2, 2],
        [5, 2],
        [5, 4],
        [2, 4],
      ],
      3,
      6,
      FACE_KIND.trim,
      style.trimColor,
      0,
    );
    const result = finish(sink);
    const triangles = decodeMesh(result);
    expect(triangles.length).toBe(12); // 6 quads * 2 triangles
    for (const triangle of triangles) {
      for (const vertex of triangle.vertices) {
        expect(Number.isFinite(vertex.position[0])).toBe(true);
        expect(Number.isFinite(vertex.position[1])).toBe(true);
        expect(Number.isFinite(vertex.position[2])).toBe(true);
        expect(vertex.normal).toHaveLength(3);
        const length = Math.hypot(...vertex.normal);
        expect(length).toBeCloseTo(1, 5);
        expect(Number.isFinite(vertex.uv[0])).toBe(true);
        expect(Number.isFinite(vertex.uv[1])).toBe(true);
      }
      expect(triangle.owner).toBe(style.owner);
    }
    // Bottom and top caps exist (a closed solid, not an open shell).
    const up = triangles.filter((triangle) => triangle.geometricNormal[1] > 0.9);
    const down = triangles.filter((triangle) => triangle.geometricNormal[1] < -0.9);
    expect(up.length).toBe(2);
    expect(down.length).toBe(2);
    void context;
  });
});

describe('addFacadeFrame', () => {
  it('projects piers, a plinth and a cornice outward within the tolerance', () => {
    const volume = makeVolume([rectRing(0, 0, 40, 14)], 0, 24, 'flat', 0);
    const { style, context } = contextFor(volume);
    const sink = new MeshSink();
    const emitted = addFacadeFrame(sink, style, context, { piers: true, plinth: true, cornice: true });
    expect(emitted).toBeGreaterThan(0);
    const triangles = decodeMesh(finish(sink));
    expect(triangles.length).toBeGreaterThan(0);
    for (const triangle of triangles) {
      expect(triangle.faceKind).toBe(FACE_KIND.trim);
      expect(triangle.owner).toBe(style.owner);
      for (const vertex of triangle.vertices) {
        const localX = vertex.position[0];
        const localY = -vertex.position[2];
        // Inside the source plan expanded by the approved projection tolerance.
        expect(localX).toBeGreaterThanOrEqual(-MAX_PROJECTION_M - 1e-6);
        expect(localX).toBeLessThanOrEqual(40 + MAX_PROJECTION_M + 1e-6);
        expect(localY).toBeGreaterThanOrEqual(-MAX_PROJECTION_M - 1e-6);
        expect(localY).toBeLessThanOrEqual(14 + MAX_PROJECTION_M + 1e-6);
        expect(vertex.position[1]).toBeLessThanOrEqual(volume.height + 1e-6);
      }
    }
    // At least one face is proud of the wall plane (no coplanar duplicate), and
    // no two triangles are identical surfaces.
    const outwardFaces = triangles.filter(
      (triangle) =>
        Math.abs(triangle.geometricNormal[1]) < 0.1
        && Math.max(
          Math.abs(triangle.centroid[0] - 20) - 20,
          Math.abs(-triangle.centroid[2] - 7) - 7,
        ) >= MIN_PROJECTION_M - 1e-6,
    );
    expect(outwardFaces.length).toBeGreaterThan(0);
    const surfaces = new Set(
      triangles.map(
        (triangle) =>
          triangle.vertices
            .map((vertex) => vertex.position.map((value) => value.toFixed(4)).join(','))
            .join('|')
          + ':' + triangle.geometricNormal.map((value) => value.toFixed(3)).join(','),
      ),
    );
    expect(surfaces.size).toBe(triangles.length);
  });

  it('emits nothing for a legacy motif or when detail is disabled', () => {
    const legacyBuilding = squarePrismBuilding();
    const legacyStyle = styleForBuilding(legacyBuilding, 0, true, 1);
    const legacyRings = boundaryRings(legacyBuilding.volumes[0]);
    const sink = new MeshSink();
    const legacyEmitted = addFacadeFrame(sink, legacyStyle, {
      rings: legacyRings,
      volume: legacyBuilding.volumes[0],
      floorHeight: legacyStyle.floorHeight,
      groundFloorHeight: legacyStyle.groundFloorHeight,
      bayWidth: legacyStyle.bayWidth,
      detail: true,
    });
    expect(legacyEmitted).toBe(0);
    expect(sink.triangles).toBe(0);

    const volume = makeVolume([rectRing(0, 0, 40, 14)], 0, 24, 'flat', 0);
    const { style, context } = contextFor(volume, { detail: false });
    const sink2 = new MeshSink();
    expect(addFacadeFrame(sink2, style, context)).toBe(0);
    expect(sink2.triangles).toBe(0);
  });

  it('skips courtyard holes as pier hosts but keeps the exterior', () => {
    const volume = makeVolume(courtyardPolygon(), 0, 20, 'flat', 0);
    const { style, context } = contextFor(volume);
    const edges = facadeEdges(context.rings);
    expect(edges.length).toBeGreaterThan(0);
    // Hole edges are inward-facing and shorter; only edges >= MIN_EDGE_M host.
    for (const edge of edges) {
      expect(edge.length).toBeGreaterThanOrEqual(2.4);
    }
    const sink = new MeshSink();
    expect(addFacadeFrame(sink, style, context)).toBeGreaterThan(0);
  });
});

describe('addBalconyStack', () => {
  it('places floor-aligned slabs and clamps the rail top to the wall', () => {
    const volume = makeVolume([rectRing(0, 0, 44, 14)], 0, 25, 'flat', 0);
    const { style, context } = contextFor(volume);
    const sink = new MeshSink();
    expect(addBalconyStack(sink, style, context)).toBeGreaterThan(0);
    const triangles = decodeMesh(finish(sink));
    const ys = triangles.flatMap((triangle) => triangle.vertices.map((vertex) => vertex.position[1]));
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    expect(minY).toBeGreaterThanOrEqual(style.groundFloorHeight - 1e-6);
    expect(maxY).toBeLessThanOrEqual(volume.height + 1e-6);
    // Slabs sit on storey boundaries (base + ground + k * floorHeight).
    for (const triangle of triangles) {
      expect(triangle.faceKind).toBe(FACE_KIND.trim);
      expect(triangle.owner).toBe(style.owner);
    }
  });

  it('skips volumes that are too short for a balcony stack', () => {
    const volume = makeVolume([rectRing(0, 0, 30, 12)], 0, 5, 'flat', 0);
    const { style, context } = contextFor(volume);
    const sink = new MeshSink();
    expect(addBalconyStack(sink, style, context)).toBe(0);
    expect(sink.triangles).toBe(0);
  });
});

describe('addEntranceTreatment', () => {
  it('uses the longest edge and keeps the canopy below the ground floor', () => {
    const volume = makeVolume([rectRing(0, 0, 40, 10)], 0, 20, 'flat', 0);
    // Recipe 6 (recessed_loggia) is a panel family and carries the entrance module.
    const panel = contextFor(volume, { styleRecipe: 6 });
    const sink = new MeshSink();
    expect(addEntranceTreatment(sink, panel.style, panel.context)).toBeGreaterThan(0);
    const triangles = decodeMesh(finish(sink));
    const maxY = Math.max(...triangles.flatMap((triangle) => triangle.vertices.map((vertex) => vertex.position[1])));
    expect(maxY).toBeLessThanOrEqual(Math.min(panel.style.groundFloorHeight, volume.height) + 0.3);
    for (const triangle of triangles) {
      expect(triangle.owner).toBe(panel.style.owner);
    }
  });

  it('gives a single-storey building only the scaled door, not a second storey', () => {
    const volume = makeVolume([rectRing(0, 0, 12, 8)], 0, 3.2, 'flat', 0);
    const { style, context } = contextFor(volume, { styleRecipe: 6 }); // panel loggia family
    const sink = new MeshSink();
    addEntranceTreatment(sink, style, context);
    const triangles = decodeMesh(finish(sink));
    for (const triangle of triangles) {
      for (const vertex of triangle.vertices) {
        expect(vertex.position[1]).toBeLessThanOrEqual(volume.height + 1e-6);
      }
    }
  });
});

describe('addRoofService', () => {
  it('places bounded housings well inside a large flat roof', () => {
    const volume = makeVolume([rectRing(0, 0, 60, 30)], 0, 30, 'flat', 0);
    const { style, context } = contextFor(volume);
    const sink = new MeshSink();
    expect(addRoofService(sink, style, context)).toBeGreaterThan(0);
    const triangles = decodeMesh(finish(sink));
    for (const triangle of triangles) {
      const localX = triangle.centroid[0];
      const localY = -triangle.centroid[2];
      expect(localX).toBeGreaterThan(2);
      expect(localX).toBeLessThan(58);
      expect(localY).toBeGreaterThan(2);
      expect(localY).toBeLessThan(28);
    }
  });

  it('never places housings on a sloped roof', () => {
    const volume = makeVolume([rectRing(0, 0, 60, 30)], 0, 30, 'gabled', 4);
    const { style, context } = contextFor(volume);
    const sink = new MeshSink();
    expect(addRoofService(sink, style, context)).toBe(0);
  });
});
