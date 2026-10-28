/**
 * Unit tests for the two curated Minsk landmarks written by landmark-dev:
 *   - Victory Square obelisk ("Монумент Победы"), building way 346312699;
 *   - Red Church ("Чырвоны касцёл"), building way 100418249.
 *
 * Both landmarks replace the generic extrusion completely, so these tests build
 * them through `buildBuildingsMesh` (the real dispatch path) and inspect the
 * decoded triangle attributes. Fixtures are self-contained and shaped like the
 * real OSM data (footprints + building:part massing hints), so no regenerated
 * city data is needed.
 */

import { describe, expect, it } from 'vitest';
import { buildBuildingsMesh } from '../../src/city/buildings/buildingsMesh';
import { MeshSink } from '../../src/city/buildings/meshSink';
import {
  addRedChurch,
  isRedChurchBuilding,
} from '../../src/city/buildings/redChurch';
import { srgbFromHex, styleForBuilding } from '../../src/city/buildings/style';
import {
  addVictoryObelisk,
  isVictoryObeliskBuilding,
} from '../../src/city/buildings/victoryObelisk';
import { FACE_KIND, ROOF_SHAPE_ID, STYLE_FLAG } from '../../src/shared/geometry';
import type { BuildingFeature, BuildingVolume, Ring } from '../../src/shared/types';
import {
  decodeMesh,
  makeBuilding,
  makeVolume,
  rectRing,
  squarePrismBuilding,
  type DecodedTriangle,
} from '../fixtures/buildings';

const GOLD = srgbFromHex('#D4AF37');
const BRONZE = srgbFromHex('#8A7333');
const GRANITE = srgbFromHex('#8A8B86');
const PLINTH = srgbFromHex('#6E6F6B');
const BRICK = srgbFromHex('#8C3B2E');
const SLATE = srgbFromHex('#3A3F45');

type Decoded = ReturnType<typeof decodeMesh>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Rotated rectangle ring (CCW in local metres). */
function rotatedRectRing(cx: number, cy: number, width: number, depth: number, angle: number): Ring {
  const hw = width / 2;
  const hd = depth / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  return corners.map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
}

/**
 * Victory Square obelisk fixture: the real monument is mapped as a 16x16 m
 * chamfered-square stylobate with a pedestal (11 m) and a pyramidion (38 m)
 * building:part volume.
 */
function makeObeliskBuilding(): BuildingFeature {
  const angle = 0.7;
  // Real OSM way 346312699 sits at about (920, 728) in local metres.
  const cx = 920;
  const cy = 728;
  // Chamfered square (octagon) stylobate, rotated like the real mapping.
  const local: [number, number][] = [
    [-7.6, -4.6],
    [-4.6, -7.6],
    [4.6, -7.6],
    [7.6, -4.6],
    [7.6, 4.6],
    [4.6, 7.6],
    [-4.6, 7.6],
    [-7.6, 4.6],
  ];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const outline: Ring = local.map(([x, y]) => [
    cx + x * cos - y * sin,
    cy + x * sin + y * cos,
  ]);
  const volumes: BuildingVolume[] = [
    // Stylobate / base block (bogus OSM height=4).
    makeVolume([outline], 0, 4, 'flat', 0),
    // Pedestal block (OSM part height=11).
    makeVolume([rotatedRectRing(cx, cy, 8.2, 8.2, angle)], 0, 11, 'flat', 0, { isPart: true }),
    // Pyramidion above the pedestal (OSM part height=38, pyramidal 4 m roof).
    makeVolume([rotatedRectRing(cx, cy, 4.17, 4.14, angle)], 11, 34, 'pyramidal', 4, {
      isPart: true,
    }),
  ];
  const building = makeBuilding(volumes, {
    id: 'w346312699',
    archetype: 'civic',
    roofShape: 'flat',
    name: 'Victory Monument',
  });
  building.osmType = 'way';
  building.osmId = 346312699;
  building.height = 38.2;
  building.tags = { historic: 'memorial', man_made: 'obelisk' };
  building.landmark = 'victory-obelisk';
  building.outline = [outline];
  return building;
}

/**
 * Red Church fixture: cross-shaped nave plan (cruciform church, ~44x34 m),
 * building:parts for the nave (25 m gabled), two 36 m facade twins, the 50 m
 * crossing tower and a low side annex.
 */
function makeRedChurchBuilding(): BuildingFeature {
  const angle = 0.42;
  // Real OSM way 100418249 sits at about (-877, -641) in local metres.
  const cx = -880;
  const cy = -640;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const toWorld = ([x, y]: [number, number]): [number, number] => [
    cx + x * cos - y * sin,
    cy + x * sin + y * cos,
  ];
  // Cruciform plan: nave along local +X (front at -22), transept bar x 5..17.
  const local: [number, number][] = [
    [-22, -9],
    [5, -9],
    [5, -17],
    [17, -17],
    [17, -9],
    [22, -9],
    [22, 9],
    [17, 9],
    [17, 17],
    [5, 17],
    [5, 9],
    [-22, 9],
  ];
  const outline: Ring = local.map(toWorld);
  const planVolume = (width: number, depth: number, centerU: number, centerV: number): BuildingVolume => {
    const worldCentre = toWorld([centerU, centerV]);
    return makeVolume(
      [rotatedRectRing(worldCentre[0], worldCentre[1], width, depth, angle)],
      0,
      22,
      'flat',
      0,
      { isPart: true },
    );
  };
  const volumes: BuildingVolume[] = [
    // Nave part (OSM eave 22 m + 3 m gabled roof = 25 m top).
    {
      ...planVolume(44, 18, 0, 0),
      roofShape: 'gabled',
      roofHeight: 3,
    },
    // Transept part (25 m gabled as well).
    {
      ...planVolume(12, 34, 11, 0),
      roofShape: 'gabled',
      roofHeight: 3,
    },
    // Low side annex (OSM 14.07 m flat).
    {
      ...planVolume(10, 8, 8, -13),
      height: 12.57,
      roofHeight: 1.5,
      roofShape: 'flat',
    },
    // Front facade twin tower hints (OSM 36 m pyramidal parts: eave 28 + 8 m
    // roof). The renderer uses only their position as the facade cluster; the
    // actual 7.2 x 7.2 m shafts are rebuilt in plan space by the module.
    makeVolume([rotatedRectRing(...toWorld([-19.5, -5.5]), 4.2, 4.4, angle)], 0, 28, 'pyramidal', 8, {
      isPart: true,
    }),
    makeVolume([rotatedRectRing(...toWorld([-19.5, 5.5]), 4.2, 4.4, angle)], 0, 28, 'pyramidal', 8, {
      isPart: true,
    }),
    // Crossing bell tower (OSM 50 m gabled: eave 42.12 + 7.88 m roof).
    makeVolume([rotatedRectRing(...toWorld([11, 3]), 9.26, 9.1, angle)], 0, 42.12, 'gabled', 7.88, {
      isPart: true,
    }),
  ];
  const building = makeBuilding(volumes, {
    id: 'w100418249',
    archetype: 'civic',
    roofShape: 'gabled',
    name: 'Church of Saints Simon and Helena',
  });
  building.osmType = 'way';
  building.osmId = 100418249;
  building.height = 50;
  building.tags = { building: 'church', religion: 'christian' };
  building.landmark = 'red-church';
  building.outline = [outline];
  return building;
}

// ---------------------------------------------------------------------------
// Inspection helpers
// ---------------------------------------------------------------------------

function buildOne(building: BuildingFeature): {
  triangles: Decoded;
  triangleCount: number;
  positions: Float32Array;
  warnings: string[];
} {
  const result = buildBuildingsMesh([building], { facadeDetail: false });
  return {
    triangles: decodeMesh(result),
    triangleCount: result.triangleCount,
    positions: result.geometry.getAttribute('position').array as Float32Array,
    warnings: result.warnings ?? [],
  };
}

function maxY(triangles: Decoded): number {
  let max = -Infinity;
  for (const triangle of triangles) {
    for (const vertex of triangle.vertices) max = Math.max(max, vertex.position[1]);
  }
  return max;
}

function colourMatches(
  triangle: DecodedTriangle,
  expected: readonly number[],
  tolerance = 2e-3,
): boolean {
  return triangle.vertices.every(
    (vertex) =>
      Math.abs(vertex.color[0] - expected[0]) < tolerance &&
      Math.abs(vertex.color[1] - expected[1]) < tolerance &&
      Math.abs(vertex.color[2] - expected[2]) < tolerance,
  );
}

function faceColourTriangles(
  triangles: Decoded,
  colour: readonly number[],
  predicate?: (triangle: DecodedTriangle) => boolean,
): DecodedTriangle[] {
  return triangles.filter(
    (triangle) => colourMatches(triangle, colour) && (!predicate || predicate(triangle)),
  );
}

function vertexHeights(triangles: readonly DecodedTriangle[]): number[] {
  const heights: number[] = [];
  for (const triangle of triangles) {
    for (const vertex of triangle.vertices) heights.push(vertex.position[1]);
  }
  return heights;
}

function directStyle(building: BuildingFeature) {
  return styleForBuilding(building, 0, false, 1);
}

function buildDirect(building: BuildingFeature, add: typeof addVictoryObelisk): {
  triangles: number;
  warnings: string[];
} {
  const sink = new MeshSink();
  const warnings: string[] = [];
  add(sink, building, directStyle(building), (message) => warnings.push(message));
  return { triangles: sink.triangles, warnings };
}

// ---------------------------------------------------------------------------
// Victory obelisk
// ---------------------------------------------------------------------------

describe('victory obelisk landmark', () => {
  const building = makeObeliskBuilding();
  const built = buildOne(building);

  it('is detected only by its own landmark predicate', () => {
    expect(isVictoryObeliskBuilding(building)).toBe(true);
    expect(isVictoryObeliskBuilding(makeRedChurchBuilding())).toBe(false);
    const unrelated = squarePrismBuilding();
    expect(isVictoryObeliskBuilding(unrelated)).toBe(false);
    expect(isRedChurchBuilding(unrelated)).toBe(false);
  });

  it('builds a non-empty mesh with finite, complete attributes (all owned by index 0)', () => {
    expect(built.warnings).toEqual([]);
    expect(built.triangleCount).toBeGreaterThan(60);
    expect(built.triangleCount).toBeLessThan(3000);
    const result = buildBuildingsMesh([building], { facadeDetail: false });
    for (const name of ['position', 'normal', 'aUV', 'aColor', 'aStyle', 'aFace']) {
      const array = result.geometry.getAttribute(name).array as Float32Array;
      let bad = 0;
      for (let i = 0; i < array.length; i++) if (!Number.isFinite(array[i])) bad++;
      expect(bad, name).toBe(0);
    }
    expect(result.triangleOwner.length).toBe(result.triangleCount);
    expect(new Set(Array.from(result.triangleOwner))).toEqual(new Set([0]));
  });

  it('reaches ~38 m with a gold star finial on top', () => {
    const top = maxY(built.triangles);
    expect(top).toBeGreaterThanOrEqual(37.5);
    expect(top).toBeLessThanOrEqual(39.5);
    const gold = faceColourTriangles(built.triangles, GOLD);
    expect(gold.length).toBeGreaterThan(0);
    const goldTop = Math.max(...vertexHeights(gold));
    expect(goldTop).toBeGreaterThan(37.5); // the star, not a relief band
    expect(goldTop).toBeCloseTo(38.2, 1);
  });

  it('has a stepped granite pedestal and bronze relief bands on the shaft', () => {
    const granite = faceColourTriangles(built.triangles, GRANITE);
    expect(granite.length).toBeGreaterThan(6);
    const plinth = faceColourTriangles(built.triangles, PLINTH);
    expect(plinth.length).toBeGreaterThan(4);
    const bronze = faceColourTriangles(built.triangles, BRONZE);
    expect(bronze.length).toBeGreaterThanOrEqual(8);
    const heights = vertexHeights(bronze);
    expect(Math.min(...heights)).toBeGreaterThan(5);
    expect(Math.max(...heights)).toBeLessThan(36);
    // Blank granite walls: no windows painted on the monument.
    const blankGranite = granite.filter(
      (triangle) => (triangle.vertices[0].face[1] & STYLE_FLAG.blank) !== 0,
    );
    expect(blankGranite.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const second = buildOne(makeObeliskBuilding());
    expect(second.triangleCount).toBe(built.triangleCount);
    expect(Array.from(second.positions)).toEqual(Array.from(built.positions));
  });

  it('warns without throwing when the outline and volumes are missing', () => {
    const empty = makeObeliskBuilding();
    delete empty.outline;
    empty.volumes = [];
    let result: { triangles: number; warnings: string[] } | null = null;
    expect(() => {
      result = buildDirect(empty, addVictoryObelisk);
    }).not.toThrow();
    expect(result!.warnings.length).toBeGreaterThan(0);
    expect(result!.warnings.join(' ')).toMatch(/outline|footprint/i);
    expect(result!.triangles).toBe(0);
  });

  it('falls back to the largest volume footprint when outline is missing', () => {
    const noOutline = makeObeliskBuilding();
    delete noOutline.outline;
    const result = buildDirect(noOutline, addVictoryObelisk);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.triangles).toBeGreaterThan(60);
  });

  it('is deterministic and stable across repeated builds (max height bucket)', () => {
    const tops = [1, 2, 3].map(() => maxY(buildOne(makeObeliskBuilding()).triangles));
    expect(new Set(tops.map((top) => top.toFixed(4))).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Red Church
// ---------------------------------------------------------------------------

describe('red church landmark', () => {
  const building = makeRedChurchBuilding();
  const built = buildOne(building);

  it('is detected only by its own landmark predicate', () => {
    expect(isRedChurchBuilding(building)).toBe(true);
    expect(isRedChurchBuilding(makeObeliskBuilding())).toBe(false);
    expect(isVictoryObeliskBuilding(building)).toBe(false);
    expect(isRedChurchBuilding(squarePrismBuilding())).toBe(false);
  });

  it('builds a non-empty mesh well under the triangle budget with finite attributes', () => {
    expect(built.triangleCount).toBeGreaterThan(200);
    expect(built.triangleCount).toBeLessThan(3000);
    expect(built.warnings).toEqual([]);
    const result = buildBuildingsMesh([building], { facadeDetail: false });
    for (const name of ['position', 'normal', 'aUV', 'aColor', 'aStyle', 'aFace']) {
      const array = result.geometry.getAttribute(name).array as Float32Array;
      let bad = 0;
      for (let i = 0; i < array.length; i++) if (!Number.isFinite(array[i])) bad++;
      expect(bad, name).toBe(0);
    }
    expect(new Set(Array.from(result.triangleOwner))).toEqual(new Set([0]));
  });

  it('reaches 48-53 m with two gold crosses above 48 m', () => {
    const top = maxY(built.triangles);
    expect(top).toBeGreaterThanOrEqual(48);
    expect(top).toBeLessThanOrEqual(53);
    const highGold = faceColourTriangles(
      built.triangles,
      GOLD,
      (triangle) => triangle.centroid[1] > 48,
    );
    expect(highGold.length).toBeGreaterThanOrEqual(2);
    // The gold above 48 m must belong to at least two separate towers.
    const xs = highGold.flatMap((triangle) => triangle.vertices.map((vertex) => vertex.position[0]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(10); // twin towers 16 m apart
    // Three tower tops: the two rebuilt facade twins + the crossing bell tower.
    const clusters: [number, number][] = [];
    for (const triangle of highGold) {
      const near = clusters.some(
        ([x, z]) => Math.hypot(x - triangle.centroid[0], z - triangle.centroid[2]) < 4,
      );
      if (!near) clusters.push([triangle.centroid[0], triangle.centroid[2]]);
    }
    expect(clusters).toHaveLength(3);
  });

  it('has a rose window (glass disc) centred in the front gable at ~26 m', () => {
    const glass = built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.glass);
    expect(glass).toHaveLength(12); // 12-gon glass fan
    const heights = vertexHeights(glass);
    expect(Math.min(...heights)).toBeGreaterThan(22); // on the gable, above the 22 m eave
    expect(Math.max(...heights)).toBeLessThan(32); // below the 31 m gable apex
    const centre = heights.reduce((sum, height) => sum + height, 0) / heights.length;
    expect(centre).toBeCloseTo(26, 0);
  });

  it('uses brick walls with window rhythm, cream stone trim and a dark slate roof', () => {
    const brickWalls = faceColourTriangles(
      built.triangles,
      BRICK,
      (triangle) =>
        triangle.faceKind === FACE_KIND.wall &&
        (triangle.vertices[0].face[1] & STYLE_FLAG.blank) === 0,
    );
    expect(brickWalls.length).toBeGreaterThan(20);
    const slate = faceColourTriangles(
      built.triangles,
      SLATE,
      (triangle) =>
        triangle.faceKind === FACE_KIND.roof &&
        triangle.roofShapeId === ROOF_SHAPE_ID.gabled,
    );
    expect(slate.length).toBeGreaterThan(8);
    const stone = faceColourTriangles(built.triangles, srgbFromHex('#D8CBB4'));
    expect(stone.length).toBeGreaterThan(10);
  });

  it('is deterministic', () => {
    const second = buildOne(makeRedChurchBuilding());
    expect(second.triangleCount).toBe(built.triangleCount);
    expect(Array.from(second.positions)).toEqual(Array.from(built.positions));
  });

  it('warns without throwing when the outline and volumes are missing', () => {
    const empty = makeRedChurchBuilding();
    delete empty.outline;
    empty.volumes = [];
    let result: { triangles: number; warnings: string[] } | null = null;
    expect(() => {
      result = buildDirect(empty, addRedChurch);
    }).not.toThrow();
    expect(result!.warnings.length).toBeGreaterThan(0);
    expect(result!.warnings.join(' ')).toMatch(/outline|footprint/i);
    expect(result!.triangles).toBe(0);
  });

  it('falls back to plan-derived front towers when no tall volumes exist', () => {
    const noTowers = makeRedChurchBuilding();
    noTowers.volumes = [
      makeVolume([rectRing(0, 0, 10, 10)], 0, 12, 'flat', 0),
    ];
    const result = buildDirect(noTowers, addRedChurch);
    expect(result.warnings.join(' ')).toMatch(/front facade towers/i);
    expect(result.triangles).toBeGreaterThan(100);
  });

  it('falls back to the largest volume footprint when outline is missing', () => {
    const noOutline = makeRedChurchBuilding();
    delete noOutline.outline;
    const result = buildDirect(noOutline, addRedChurch);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.triangles).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Dispatch integration
// ---------------------------------------------------------------------------

describe('curated landmark dispatch', () => {
  it('renders the out-of-order mixed tile without touching other buildings', () => {
    const ordinary = squarePrismBuilding();
    const result = buildBuildingsMesh([ordinary, makeObeliskBuilding(), makeRedChurchBuilding()], {
      facadeDetail: false,
    });
    const ordinaryOnly = buildBuildingsMesh([ordinary], { facadeDetail: false });
    // The ordinary building keeps its generic 10-triangle prism.
    expect(ordinaryOnly.triangleCount).toBe(10);
    const owners = Array.from(result.triangleOwner);
    expect(owners.filter((owner) => owner === 0)).toHaveLength(10);
    expect(owners.filter((owner) => owner === 1).length).toBeGreaterThan(60);
    expect(owners.filter((owner) => owner === 2).length).toBeGreaterThan(200);
    expect(owners.every((owner) => owner <= 2)).toBe(true);
  });

  it('an ordinary building is not matched by either landmark predicate', () => {
    const ordinary = squarePrismBuilding();
    expect(isVictoryObeliskBuilding(ordinary)).toBe(false);
    expect(isRedChurchBuilding(ordinary)).toBe(false);
    // ...and the generic mesh is unchanged (no spire/star/cross was appended).
    const built = buildOne(ordinary);
    expect(built.triangleCount).toBe(10);
    expect(built.warnings).toEqual([]);
  });
});
