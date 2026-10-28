/**
 * Unit tests for the National Library of Belarus curated landmark.
 *
 * The landmark is rebuilt from `building.outline` + measured constants; the OSM
 * `volumes` (bogus building:part diamond faces / a 73 m tower) must be ignored
 * entirely by the curated-landmark route.
 */

import { describe, expect, it } from 'vitest';
import { buildBuildingsMesh } from '../../src/city/buildings/buildingsMesh';
import {
  isNationalLibraryBuilding,
  NATIONAL_LIBRARY_BAND_HEIGHTS,
  NATIONAL_LIBRARY_CORNICE_STONE,
  NATIONAL_LIBRARY_DIAMOND_COLOURS,
  NATIONAL_LIBRARY_DIAMOND_TOP,
  NATIONAL_LIBRARY_GLASS_BAND,
  NATIONAL_LIBRARY_GLASS_BOTTOM,
  NATIONAL_LIBRARY_GLASS_TOP,
  NATIONAL_LIBRARY_PODIUM_STONE,
  NATIONAL_LIBRARY_PODIUM_TOP,
  NATIONAL_LIBRARY_SKIRT_STONE,
} from '../../src/city/buildings/nationalLibrary';
import { FACE_KIND, STYLE_FLAG } from '../../src/shared/geometry';
import type { BuildingFeature, BuildingVolume, Polygon } from '../../src/shared/types';
import { decodeMesh, type DecodedTriangle } from '../fixtures/buildings';

const SQUARE_OUTLINE: Polygon = [
  [
    [0, 0],
    [160, 0],
    [160, 160],
    [0, 160],
  ],
];

function bogusVolumes(): BuildingVolume[] {
  // Deliberately unhelpful OSM data: diamond-face part polygons and a 73 m
  // "tower" part that must never be rendered as a box.
  return [
    {
      footprint: [
        [
          [60, 60],
          [100, 60],
          [100, 100],
          [60, 100],
        ],
      ],
      minHeight: 11,
      height: 70,
      roofShape: 'pyramidal',
      roofHeight: 10,
      heightSource: 'osm_height',
      isPart: true,
    },
    {
      footprint: [
        [
          [40, 40],
          [120, 40],
          [120, 120],
          [40, 120],
        ],
      ],
      minHeight: 0,
      height: 73,
      roofShape: 'flat',
      roofHeight: 0,
      heightSource: 'osm_height',
      isPart: true,
    },
  ];
}

function makeLibrary(overrides: Partial<BuildingFeature> = {}): BuildingFeature {
  return {
    id: 'w1001',
    osmType: 'way',
    osmId: 1001,
    name: 'Нацыянальная бібліятэка Беларусі',
    archetype: 'civic',
    height: 71.6,
    roofShape: 'flat',
    volumes: bogusVolumes(),
    tags: { building: 'yes' },
    outline: SQUARE_OUTLINE,
    landmark: 'national-library',
    ...overrides,
  };
}

interface Built {
  triangles: DecodedTriangle[];
  triangleCount: number;
  positions: Float32Array;
  warnings: string[];
}

function build(building: BuildingFeature, facadeDetail = true): Built {
  const result = buildBuildingsMesh([building], { facadeDetail });
  return {
    triangles: decodeMesh(result),
    triangleCount: result.triangleCount,
    positions: result.geometry.getAttribute('position').array as Float32Array,
    warnings: result.warnings ?? [],
  };
}

function maxY(triangles: readonly DecodedTriangle[]): number {
  let max = -Infinity;
  for (const triangle of triangles) {
    for (const vertex of triangle.vertices) max = Math.max(max, vertex.position[1]);
  }
  return max;
}

function colourKey(triangle: DecodedTriangle): string {
  return triangle.vertices[0].color.map((channel) => Math.round(channel * 255)).join(',');
}

function matchesAnyColour(
  triangle: DecodedTriangle,
  colours: readonly (readonly number[])[],
  tolerance = 2e-3,
): boolean {
  return colours.some((colour) =>
    triangle.vertices.every(
      (vertex) =>
        Math.abs(vertex.color[0] - colour[0]) < tolerance &&
        Math.abs(vertex.color[1] - colour[1]) < tolerance &&
        Math.abs(vertex.color[2] - colour[2]) < tolerance,
    ),
  );
}

describe('national library landmark detection', () => {
  it('matches only the national-library landmark id', () => {
    expect(isNationalLibraryBuilding(makeLibrary())).toBe(true);
    const other = makeLibrary();
    delete other.landmark;
    expect(isNationalLibraryBuilding(other)).toBe(false);
  });
});

describe('national library geometry', () => {
  const built = build(makeLibrary());
  const diamondTriangles = built.triangles.filter((triangle) =>
    matchesAnyColour(triangle, NATIONAL_LIBRARY_DIAMOND_COLOURS),
  );

  it('builds the landmark without warnings', () => {
    expect(built.warnings).toEqual([]);
    expect(built.triangleCount).toBeGreaterThan(100);
    expect(maxY(built.triangles)).toBeGreaterThanOrEqual(NATIONAL_LIBRARY_DIAMOND_TOP - 0.6);
    expect(maxY(built.triangles)).toBeLessThanOrEqual(NATIONAL_LIBRARY_DIAMOND_TOP + 0.6);
  });

  it('reaches the measured diamond top and podium deck heights', () => {
    expect(maxY(built.triangles)).toBeGreaterThanOrEqual(NATIONAL_LIBRARY_DIAMOND_TOP - 0.6);
    expect(maxY(built.triangles)).toBeLessThanOrEqual(NATIONAL_LIBRARY_DIAMOND_TOP + 0.6);
    const roofFaces = built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.roof);
    expect(roofFaces.length).toBeGreaterThan(0);
    for (const triangle of roofFaces) {
      for (const vertex of triangle.vertices) {
        expect(vertex.position[1]).toBeCloseTo(NATIONAL_LIBRARY_PODIUM_TOP, 3);
      }
    }
    // Podium deck area covers the 160x160 m outline.
    const deckArea = roofFaces.reduce((sum, triangle) => sum + triangle.areaXY, 0);
    expect(deckArea).toBeCloseTo(160 * 160, 0);
  });

  it('builds a 26-face rhombicuboctahedron diamond', () => {
    // 18 square faces (36 triangles) + 8 triangular faces (8) = 44 triangles.
    expect(diamondTriangles).toHaveLength(44);
    const normals = new Set(
      diamondTriangles.map((triangle) =>
        triangle.vertices[0].normal.map((component) => Math.round(component * 1000) / 1000).join(','),
      ),
    );
    expect(normals.size).toBe(26);
    // Unit normals.
    for (const triangle of diamondTriangles) {
      for (const vertex of triangle.vertices) {
        expect(Math.hypot(...vertex.normal)).toBeCloseTo(1, 4);
      }
    }
  });

  it('uses at least three blue-glass band colours, including a light top', () => {
    const colours = new Set(diamondTriangles.map((triangle) => colourKey(triangle)));
    expect(colours.size).toBeGreaterThanOrEqual(3);
    // The horizontal top square is the light roof-glass colour.
    const topFaces = diamondTriangles.filter((triangle) =>
      triangle.vertices.every((vertex) => vertex.normal[1] > 0.99),
    );
    expect(topFaces.length).toBeGreaterThan(0);
    for (const triangle of topFaces) {
      expect(colourKey(triangle)).toBe(
        NATIONAL_LIBRARY_DIAMOND_COLOURS[3].map((channel) => Math.round(channel * 255)).join(','),
      );
    }
  });

  it('uses flat-shaded diamond faces and blank walls (no procedural windows)', () => {
    for (const triangle of diamondTriangles) {
      expect(triangle.faceKind).toBe(FACE_KIND.wall);
      expect(triangle.vertices[0].face[1] & STYLE_FLAG.blank).not.toBe(0);
      // All vertices of one face share the same explicit normal.
      expect(triangle.vertices[1].normal).toEqual(triangle.vertices[0].normal);
      expect(triangle.vertices[2].normal).toEqual(triangle.vertices[0].normal);
    }
  });

  it('adds aluminium mullion rims at the three band boundaries', () => {
    const rimTriangles = built.triangles.filter((triangle) => {
      if (triangle.faceKind !== FACE_KIND.trim) return false;
      return triangle.vertices.every(
        (vertex) => Math.abs(vertex.position[1] - NATIONAL_LIBRARY_BAND_HEIGHTS[0]) < 8,
      );
    });
    expect(rimTriangles.length).toBeGreaterThan(0);
  });

  it('writes finite, complete vertex attributes and correct owners', () => {
    const result = buildBuildingsMesh([makeLibrary()], { facadeDetail: true });
    for (const name of ['position', 'normal', 'aUV', 'aColor', 'aStyle', 'aFace']) {
      const array = result.geometry.getAttribute(name).array as Float32Array;
      let bad = 0;
      for (let i = 0; i < array.length; i++) if (!Number.isFinite(array[i])) bad++;
      expect(bad, name).toBe(0);
    }
    expect(result.triangleOwner.length).toBe(result.triangleCount);
    expect(new Set(Array.from(result.triangleOwner))).toEqual(new Set([0]));
    expect(result.buildingIds).toEqual(['w1001']);
  });

  it('ignores the OSM volumes entirely', () => {
    const withoutBogus = makeLibrary({
      volumes: [
        {
          footprint: [
            [
              [10, 10],
              [20, 10],
              [20, 20],
              [10, 20],
            ],
          ],
          minHeight: 0,
          height: 73,
          roofShape: 'flat',
          roofHeight: 0,
          heightSource: 'osm_height',
        },
      ],
    });
    const other = build(withoutBogus);
    expect(other.warnings).toEqual([]);
    expect(other.triangleCount).toBe(built.triangleCount);
    expect(Array.from(other.positions)).toEqual(Array.from(built.positions));
    // The bogus 73 m tower volume must not raise the skyline.
    expect(maxY(other.triangles)).toBeLessThanOrEqual(NATIONAL_LIBRARY_DIAMOND_TOP + 0.6);
  });

  it('is deterministic (same input twice -> identical mesh)', () => {
    const second = build(makeLibrary());
    expect(second.triangleCount).toBe(built.triangleCount);
    expect(Array.from(second.positions)).toEqual(Array.from(built.positions));
  });

  it('keeps a warm light-stone podium facade (procedural civic windows, not blank)', () => {
    const podiumWalls = built.triangles.filter(
      (triangle) =>
        triangle.faceKind === FACE_KIND.wall &&
        !matchesAnyColour(triangle, NATIONAL_LIBRARY_DIAMOND_COLOURS),
    );
    expect(podiumWalls.length).toBeGreaterThan(0);
    for (const triangle of podiumWalls) {
      expect(triangle.vertices[0].face[1] & STYLE_FLAG.blank).toBe(0);
      // Explicit warm light-stone palette instead of the generic civic colour.
      expect(matchesAnyColour(triangle, [NATIONAL_LIBRARY_PODIUM_STONE])).toBe(true);
    }
  });

  it('adds a dark glazed skirt band around the podium base', () => {
    const glass = built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.glass);
    expect(glass.length).toBeGreaterThan(0);
    for (const triangle of glass) {
      expect(triangle.vertices[0].face[1] & STYLE_FLAG.blank).not.toBe(0);
      expect(matchesAnyColour(triangle, [NATIONAL_LIBRARY_GLASS_BAND])).toBe(true);
      for (const vertex of triangle.vertices) {
        expect(vertex.position[1]).toBeGreaterThanOrEqual(NATIONAL_LIBRARY_GLASS_BOTTOM - 1e-3);
        expect(vertex.position[1]).toBeLessThanOrEqual(NATIONAL_LIBRARY_GLASS_TOP + 1e-3);
      }
    }
  });

  it('reads the terrace step darker than the light cornice band', () => {
    const trim = built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.trim);
    const skirt = trim.filter((triangle) =>
      triangle.vertices.every((vertex) => vertex.position[1] <= 1.8 + 1e-3),
    );
    expect(skirt.length).toBeGreaterThan(0);
    for (const triangle of skirt) {
      expect(matchesAnyColour(triangle, [NATIONAL_LIBRARY_SKIRT_STONE])).toBe(true);
    }
    const cornice = trim.filter((triangle) =>
      triangle.vertices.every(
        (vertex) =>
          vertex.position[1] >= 11.5 - 1e-3 &&
          vertex.position[1] <= NATIONAL_LIBRARY_PODIUM_TOP + 1e-3,
      ),
    );
    expect(cornice.length).toBeGreaterThan(0);
    for (const triangle of cornice) {
      expect(matchesAnyColour(triangle, [NATIONAL_LIBRARY_CORNICE_STONE])).toBe(true);
    }
  });
});

describe('national library robustness', () => {
  it('missing outline -> warning, no throw', () => {
    const building = makeLibrary();
    delete building.outline;
    const built = build(building);
    expect(built.warnings.join(' ')).toMatch(/outline/i);
    expect(built.triangleCount).toBe(0);
  });

  it('degenerate outline -> warning, no throw', () => {
    const built = build(
      makeLibrary({
        outline: [
          [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
        ],
      }),
    );
    expect(built.warnings.join(' ')).toMatch(/outline/i);
    expect(built.triangleCount).toBe(0);
  });

  it('empty building -> warning, no throw', () => {
    const building = makeLibrary({ volumes: [] });
    const result = buildBuildingsMesh([building], { facadeDetail: true });
    expect((result.warnings ?? []).join(' ')).toMatch(/no volumes/i);
    expect(result.triangleCount).toBe(0);
  });

  it('non-landmark buildings are untouched', () => {
    const square: BuildingFeature = {
      id: 'w2001',
      osmType: 'way',
      osmId: 2001,
      archetype: 'panel',
      height: 12,
      roofShape: 'flat',
      volumes: [
        {
          footprint: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
            ],
          ],
          minHeight: 0,
          height: 12,
          roofShape: 'flat',
          roofHeight: 0,
          heightSource: 'osm_height',
        },
      ],
      tags: {},
    };
    expect(isNationalLibraryBuilding(square)).toBe(false);
    const built = build(square, false);
    expect(built.triangleCount).toBe(10);
    expect(maxY(built.triangles)).toBeCloseTo(12, 3);
  });
});
