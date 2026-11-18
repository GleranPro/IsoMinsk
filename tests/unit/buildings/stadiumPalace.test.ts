/**
 * Unit tests for the Milestone-B follow-up special cases:
 *  - stadium bowl geometry (relation r8414582 / Dynamo Stadium),
 *  - grandstand rake instead of a slab,
 *  - palace massing accents (plinth + stacked cornice/attic bands).
 */

import { describe, expect, it } from 'vitest';
import { buildBuildingsMesh } from '../../../src/city/buildings/buildingsMesh';
import { ARCHETYPE_ID, FACE_KIND, STYLE_FLAG } from '../../../src/shared/geometry';
import { ENV_PALETTE } from '../../../src/engine/materials/palette';
import { srgbFromHex } from '../../../src/city/buildings/style';
import { signedArea } from '../../../src/city/buildings/polygon2d';
import {
  decodeMesh,
  ellipseRing,
  grandstandBuilding,
  makeBuilding,
  makeVolume,
  palaceBuilding,
  rectRing,
  squarePrismBuilding,
  stadiumBuilding,
  sumAreaXY,
  type DecodedTriangle,
} from '../../fixtures/buildings';

const ARENA_RING = 44;

function build(buildings: Parameters<typeof buildBuildingsMesh>[0], facadeDetail = true) {
  const result = buildBuildingsMesh(buildings, { facadeDetail });
  const triangles = decodeMesh(result);
  return { result, triangles };
}

function ellipseDistanceSq(x: number, z: number, cx = 103, cy = 68, rx = 103, ry = 68): number {
  const localY = -z;
  return ((x - cx) / rx) ** 2 + ((localY - cy) / ry) ** 2;
}

describe('stadium bowl', () => {
  it('meshes the arena as outer wall + sloped stands + inner rim + pitch', () => {
    const { result, triangles } = build([stadiumBuilding()]);

    // 44 edges * (outer wall 2 + stands 2 + inner rim 2) + 42 pitch triangles.
    expect(result.triangleCount).toBe(ARENA_RING * 6 + (ARENA_RING - 2));
    expect(result.buildingIds).toEqual(['r8414582']);
    expect(result.triangleOwner.length).toBe(result.triangleCount);
    expect(new Set(Array.from(result.triangleOwner))).toEqual(new Set([0]));
    expect(result.warnings).toEqual([]);

    // Outer wall (vertical, 0..16.8) + inner rim wall (0..2.5): 2*44 quads.
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.wall)).toHaveLength(ARENA_RING * 4);
    // One sloped stand quad per edge.
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.trim)).toHaveLength(ARENA_RING * 2);

    // No slab: nothing horizontal above gutter height.
    const highFlat = triangles.filter(
      (t) => t.centroid[1] > 2 && Math.abs(t.vertices[0].normal[1]) > 0.99,
    );
    expect(highFlat).toHaveLength(0);
    const highest = Math.max(...triangles.flatMap((t) => t.vertices.map((v) => v.position[1])));
    expect(highest).toBeCloseTo(16.8, 3);
  });

  it('ignores the inner detail volume (no double geometry)', () => {
    const twoVolumes = build([stadiumBuilding()]);
    const singleVolumeBuilding = stadiumBuilding();
    singleVolumeBuilding.volumes = singleVolumeBuilding.volumes.slice(0, 1);
    const oneVolume = build([singleVolumeBuilding]);
    expect(oneVolume.result.triangleCount).toBe(twoVolumes.result.triangleCount);
    const a = oneVolume.result.geometry.getAttribute('position').array as Float32Array;
    const b = twoVolumes.result.geometry.getAttribute('position').array as Float32Array;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('outer walls face outwards and stands face up towards the pitch', () => {
    const { triangles } = build([stadiumBuilding()]);
    const walls = triangles.filter((t) => t.faceKind === FACE_KIND.wall);
    // The outer wall is the subset whose plan centroid is on the arena rim.
    const outerWalls = walls.filter(
      (t) => ellipseDistanceSq(t.centroid[0], t.centroid[2]) > 0.9,
    );
    expect(outerWalls.length).toBeGreaterThan(0);
    for (const triangle of outerWalls) {
      const normal = triangle.vertices[0].normal;
      expect(Math.abs(normal[1])).toBeLessThan(1e-6);
      // Step outward along the normal: end up outside the arena ellipse.
      const x = triangle.centroid[0] + normal[0] * 0.4;
      const z = triangle.centroid[2] + normal[2] * 0.4;
      expect(ellipseDistanceSq(x, z)).toBeGreaterThan(1);
    }

    const stands = triangles.filter((t) => t.faceKind === FACE_KIND.trim);
    for (const triangle of stands) {
      const normal = triangle.vertices[0].normal;
      expect(normal[1]).toBeGreaterThan(0.2);
      const localY = -triangle.centroid[2];
      // Horizontal component points towards the centre of the arena.
      const towardsX = 103 - triangle.centroid[0];
      const towardsY = 68 - localY;
      expect(normal[0] * towardsX - normal[2] * towardsY).toBeGreaterThan(0);
    }
  });

  it('covers the infield with a flat green pitch face', () => {
    const { triangles } = build([stadiumBuilding()]);
    const pitch = triangles.filter((t) => t.faceKind === FACE_KIND.roof);
    expect(pitch.length).toBe(ARENA_RING - 2);
    const expectedColour = srgbFromHex(ENV_PALETTE.pitch);
    for (const triangle of pitch) {
      for (const vertex of triangle.vertices) {
        expect(vertex.position[1]).toBeCloseTo(0.35, 3);
        expect(Math.abs(vertex.color[0] - expectedColour[0])).toBeLessThan(1e-3);
        expect(Math.abs(vertex.color[1] - expectedColour[1])).toBeLessThan(1e-3);
        expect(Math.abs(vertex.color[2] - expectedColour[2])).toBeLessThan(1e-3);
        expect(vertex.face[1] & STYLE_FLAG.blank).not.toBe(0);
      }
    }
    const outerRing = ellipseRing(103, 68, 103, 68, 44);
    const outerArea = Math.abs(signedArea(outerRing.map(([x, y]) => [x, y] as [number, number])));
    const fieldArea = sumAreaXY(pitch);
    // Radial scale 0.52 => field is ~27 % of the arena footprint.
    expect(fieldArea / outerArea).toBeGreaterThan(0.24);
    expect(fieldArea / outerArea).toBeLessThan(0.3);
  });

  it('a plain extrusion of the same footprint would still be a slab (contrast)', () => {
    const arena = ellipseRing(103, 68, 103, 68, 44);
    const slab = makeBuilding([makeVolume([arena], 0, 16.8, 'flat', 0)], {
      id: 'w9900',
      archetype: 'office',
    });
    const { triangles } = build([slab]);
    // The flat cap sits at the declared height minus the in-envelope parapet
    // slice, so match by face kind rather than one exact y.
    const slabRoof = triangles.filter((t) => t.faceKind === FACE_KIND.roof);
    expect(sumAreaXY(slabRoof)).toBeGreaterThan(20000);
  });
});

describe('grandstand', () => {
  it('renders as a low blank rake, not a box slab', () => {
    const { result, triangles } = build([grandstandBuilding()]);
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);

    // Every wall-ish face is blank (no windows) and the stand is low.
    for (const triangle of triangles) {
      if (triangle.faceKind === FACE_KIND.roof || triangle.faceKind === FACE_KIND.roofRidge) continue;
      expect(triangle.vertices[0].face[1] & STYLE_FLAG.blank).not.toBe(0);
    }
    const sloped = triangles.filter((t) => t.faceKind === FACE_KIND.roofRidge);
    expect(sloped.length).toBeGreaterThan(0);
    for (const triangle of sloped) {
      const normalY = Math.abs(triangle.vertices[0].normal[1]);
      expect(normalY).toBeGreaterThan(0.1);
      expect(normalY).toBeLessThan(0.995);
    }
    const highest = Math.max(...triangles.flatMap((t) => t.vertices.map((v) => v.position[1])));
    // 10 m eave capped, plus the skillion rise (<= 5 m).
    expect(highest).toBeGreaterThan(10);
    expect(highest).toBeLessThan(15.5);
  });
});

describe('palace massing accents', () => {
  it('adds plinth + two stacked projecting trim bands per volume', () => {
    const { result, triangles } = build([palaceBuilding()], false);
    // Walls: 4 edges * 2 tris; flat cap: 2 tris; accents: 4 edges * 3 bands * 4 tris.
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.wall)).toHaveLength(8);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.roof)).toHaveLength(2);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.trim)).toHaveLength(32);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.ground)).toHaveLength(16);
    expect(result.triangleCount).toBe(8 + 2 + 32 + 16);
    expect(result.warnings).toEqual([]);

    // Every triangle keeps the palace archetype id in aStyle.x.
    for (const triangle of triangles) {
      expect(triangle.vertices[0].style[0]).toBe(ARCHETYPE_ID.palace);
    }

    // Plinth reaches 1.2 m, attic tops out at eave + 0.4 m.
    const ground = triangles.filter((t) => t.faceKind === FACE_KIND.ground);
    const groundMax = Math.max(...ground.flatMap((t) => t.vertices.map((v) => v.position[1])));
    expect(groundMax).toBeCloseTo(1.2, 3);
    const trim = triangles.filter((t) => t.faceKind === FACE_KIND.trim);
    const trimHeights = trim.flatMap((t) => t.vertices.map((v) => v.position[1]));
    expect(Math.max(...trimHeights)).toBeCloseTo(22.4, 3); // attic band top
    expect(trimHeights.some((h) => Math.abs(h - 22) < 1e-3)).toBe(true); // cornice/attic seam
    expect(trimHeights.some((h) => Math.abs(h - 21.1) < 1e-3)).toBe(true); // cornice underside

    // Bands project 0.35 m beyond the 30x20 m wall.
    const maxX = Math.max(...triangles.flatMap((t) => t.vertices.map((v) => v.position[0])));
    const maxAbsZ = Math.max(...triangles.flatMap((t) => t.vertices.map((v) => Math.abs(v.position[2]))));
    expect(maxX).toBeCloseTo(30.35, 3);
    expect(maxAbsZ).toBeCloseTo(20.35, 3);
  });

  it('keeps triangleOwner semantics across mixed special buildings', () => {
    const buildings = [palaceBuilding(), stadiumBuilding(), squarePrismBuilding()];
    const { result, triangles } = build(buildings, false);
    expect(result.buildingIds).toEqual(['w25327560', 'r8414582', 'w2001']);
    expect(result.triangleOwner.length).toBe(result.triangleCount);
    expect(new Set(Array.from(result.triangleOwner))).toEqual(new Set([0, 1, 2]));
    let previous = -1;
    for (const owner of result.triangleOwner) {
      expect(owner).toBeGreaterThanOrEqual(previous);
      previous = owner;
    }
    const stadiumTriangles = triangles.filter((t) => t.owner === 1);
    expect(stadiumTriangles.length).toBe(ARENA_RING * 6 + (ARENA_RING - 2));
    expect(result.triangleOwner[stadiumTriangles[0].index]).toBe(1);
  });

  it('does not apply palace accents to ordinary buildings', () => {
    const { triangles } = build([squarePrismBuilding()], false);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.trim)).toHaveLength(0);
    expect(triangles.filter((t) => t.faceKind === FACE_KIND.ground)).toHaveLength(0);
  });
});
