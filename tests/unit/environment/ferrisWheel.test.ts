import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AttractionFeature, TileData } from '../../../src/shared/types';
import {
  CABIN_RED_SHADES,
  CABIN_ROOF_CREAM,
  CABIN_YELLOW_SHADES,
  FERRIS_WHEEL_CABIN_TRIANGLES,
  FERRIS_WHEEL_COLORS,
  FERRIS_WHEEL_TRIANGLE_BUDGET,
  buildAttractionGeometry,
  emitAttractions,
  ferrisWheelAxes,
  ferrisWheelCabinDimensions,
} from '../../../src/city/environment/ferrisWheel';
import { GeometrySink } from '../../../src/city/environment/meshBuilder';
import { buildEnvironmentMeshes } from '../../../src/city/environment/environmentMeshes';

type Vec3 = [number, number, number];

/** Gorky Park wheel (measured: hub 28.6 m, rim 25 m, 54 m tall, 36 cabins). */
function gorky(overrides: Partial<AttractionFeature> = {}): AttractionFeature {
  return {
    id: 'n3588199861',
    type: 'ferris-wheel',
    name: 'Gorky Park Ferris Wheel',
    x: 350,
    y: -120,
    radius: 25,
    hubHeight: 28.6,
    height: 54,
    cabins: 36,
    openCabins: 4,
    rotation: (70.87 * Math.PI) / 180,
    ...overrides,
  };
}

/** Chelyuskintsev Park wheel (smaller: hub 14.6 m, rim 12.8 m). */
function chelyuskintsev(overrides: Partial<AttractionFeature> = {}): AttractionFeature {
  return {
    id: 'n1234567',
    type: 'ferris-wheel',
    name: 'Chelyuskintsev Park Ferris Wheel',
    x: -140,
    y: 260,
    radius: 12.8,
    hubHeight: 14.6,
    height: 27.4,
    cabins: 18,
    openCabins: 2,
    rotation: (303.39 * Math.PI) / 180,
    ...overrides,
  };
}

interface ReadTriangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  normal: Vec3;
}

function readTriangles(geometry: THREE.BufferGeometry): ReadTriangle[] {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const index = geometry.getIndex();
  expect(position).toBeTruthy();
  expect(normal).toBeTruthy();
  expect(index).not.toBeNull();
  const positions = position.array as Float32Array;
  const normals = normal.array as Float32Array;
  const indices = index!.array as Uint32Array;
  const triangles: ReadTriangle[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    triangles.push({
      a: [positions[i0], positions[i0 + 1], positions[i0 + 2]],
      b: [positions[i1], positions[i1 + 1], positions[i1 + 2]],
      c: [positions[i2], positions[i2 + 1], positions[i2 + 2]],
      normal: [normals[i0], normals[i0 + 1], normals[i0 + 2]],
    });
  }
  return triangles;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function triangleArea(triangle: ReadTriangle): number {
  return Math.hypot(...cross(sub(triangle.b, triangle.a), sub(triangle.c, triangle.a))) / 2;
}

function linearHex(hex: string): [number, number, number] {
  const color = new THREE.Color(hex).convertSRGBToLinear();
  return [color.r, color.g, color.b];
}

function colorEquals(actual: ArrayLike<number>, offset: number, expected: [number, number, number]): boolean {
  return (
    Math.abs(actual[offset] - expected[0]) < 1e-5 &&
    Math.abs(actual[offset + 1] - expected[1]) < 1e-5 &&
    Math.abs(actual[offset + 2] - expected[2]) < 1e-5
  );
}

function assertValidAttractionGeometry(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const color = geometry.getAttribute('color');
  const index = geometry.getIndex();
  expect(position, `${label} position`).toBeTruthy();
  expect(normal, `${label} normal`).toBeTruthy();
  expect(color, `${label} color`).toBeTruthy();
  // Same colour contract as the rest of the environment: standard linear `color`.
  expect(geometry.getAttribute('aColor'), `${label} no aColor`).toBeUndefined();
  expect(index, `${label} index`).not.toBeNull();

  const positions = position.array as Float32Array;
  const normals = normal.array as Float32Array;
  const colors = color.array as Float32Array;
  const indices = index!.array as Uint32Array;
  let finite = true;
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) finite = false;
  for (let i = 0; i < normals.length; i++) if (!Number.isFinite(normals[i])) finite = false;
  for (let i = 0; i < colors.length; i++) if (!Number.isFinite(colors[i])) finite = false;
  expect(finite, `${label} all attributes finite`).toBe(true);
  expect(indices.length % 3, `${label} index count`).toBe(0);

  let indicesValid = true;
  for (let i = 0; i < indices.length; i++) {
    const vertex = indices[i];
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= position.count) indicesValid = false;
  }
  expect(indicesValid, `${label} indices in range`).toBe(true);

  for (const triangle of readTriangles(geometry)) {
    expect(triangleArea(triangle), `${label} non-degenerate triangle`).toBeGreaterThan(1e-9);
    const normalLength = Math.hypot(...triangle.normal);
    expect(normalLength, `${label} unit normal`).toBeCloseTo(1, 3);
    const faceNormal = cross(sub(triangle.b, triangle.a), sub(triangle.c, triangle.a));
    const dot =
      faceNormal[0] * triangle.normal[0] +
      faceNormal[1] * triangle.normal[1] +
      faceNormal[2] * triangle.normal[2];
    expect(dot, `${label} winding matches normal`).toBeGreaterThan(0);
  }
}

function bounds(geometry: THREE.BufferGeometry): { min: Vec3; max: Vec3 } {
  const positions = geometry.getAttribute('position').array as Float32Array;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[i + axis]);
      max[axis] = Math.max(max[axis], positions[i + axis]);
    }
  }
  return { min, max };
}

/**
 * Count the triangles that belong to hanging cabins: every vertex must be
 * close to the wheel plane (|axle offset| small) and in the annular band the
 * cabins occupy. Every other part of the model (rims, spokes, hub, sign,
 * supports, deck) is outside that region by construction.
 */
function isCabinTriangle(triangle: ReadTriangle, attraction: AttractionFeature): boolean {
  const frame = ferrisWheelAxes(attraction.rotation);
  const hub: Vec3 = [attraction.x, attraction.hubHeight, -attraction.y];
  const dims = ferrisWheelCabinDimensions(attraction.radius);
  const maxAxial = dims.roofHalfA * 1.12;
  const minRadius = attraction.radius - 2.6 * dims.scale;
  const maxRadius = attraction.radius + 2.4 * dims.scale;
  return [triangle.a, triangle.b, triangle.c].every((point) => {
    const dx = point[0] - hub[0];
    const dz = point[2] - hub[2];
    const dy = point[1] - hub[1];
    const axial = dx * frame.ax + dz * frame.az;
    const planeU = dx * frame.ux + dz * frame.uz;
    if (Math.abs(axial) > maxAxial) return false;
    const radial = Math.hypot(planeU, dy);
    return radial >= minRadius && radial <= maxRadius;
  });
}

function countCabinTriangles(geometry: THREE.BufferGeometry, attraction: AttractionFeature): number {
  return readTriangles(geometry).filter((triangle) => isCabinTriangle(triangle, attraction)).length;
}

function countColoredVertices(geometry: THREE.BufferGeometry, hex: string): number {
  const colors = geometry.getAttribute('color').array as Float32Array;
  const expected = linearHex(hex);
  let count = 0;
  for (let i = 0; i < colors.length; i += 3) {
    if (colorEquals(colors, i, expected)) count++;
  }
  return count;
}

function triangleCountFor(attractions: AttractionFeature[]): number {
  const geometry = buildAttractionGeometry(attractions);
  if (!geometry) return 0;
  const index = geometry.getIndex();
  return index ? index.count / 3 : 0;
}

describe('ferrisWheelAxes', () => {
  it('returns orthonormal in-plane and axle directions', () => {
    for (const rotation of [0, Math.PI / 4, (70.87 * Math.PI) / 180, (303.39 * Math.PI) / 180]) {
      const frame = ferrisWheelAxes(rotation);
      expect(Math.hypot(frame.ux, frame.uz)).toBeCloseTo(1, 9);
      expect(Math.hypot(frame.ax, frame.az)).toBeCloseTo(1, 9);
      expect(frame.ux * frame.ax + frame.uz * frame.az).toBeCloseTo(0, 9);
    }
  });

  it('rotates the plane with the bearing (east at 0, north-ish at +90°)', () => {
    const east = ferrisWheelAxes(0);
    expect(east.ux).toBeCloseTo(1, 9);
    expect(east.uz).toBeCloseTo(0, 9);
    expect(east.ax).toBeCloseTo(0, 9);
    expect(east.az).toBeCloseTo(-1, 9);
    const north = ferrisWheelAxes(Math.PI / 2);
    expect(north.ux).toBeCloseTo(0, 9);
    expect(north.uz).toBeCloseTo(-1, 9);
    expect(north.ax).toBeCloseTo(-1, 9);
    expect(north.az).toBeCloseTo(0, 9);
  });
});

describe('buildAttractionGeometry — structure', () => {
  it('returns null for empty / missing / non-array input', () => {
    expect(buildAttractionGeometry([])).toBeNull();
    expect(buildAttractionGeometry(undefined)).toBeNull();
    expect(buildAttractionGeometry(null)).toBeNull();
    expect(buildAttractionGeometry('nope' as unknown as AttractionFeature[])).toBeNull();
  });

  it('builds both real-world wheels within the triangle budget', () => {
    const gorkyGeometry = buildAttractionGeometry([gorky()])!;
    const chelyuskintsevGeometry = buildAttractionGeometry([chelyuskintsev()])!;
    expect(gorkyGeometry).not.toBeNull();
    expect(chelyuskintsevGeometry).not.toBeNull();
    const gorkyTriangles = gorkyGeometry.getIndex()!.count / 3;
    const chelyuskintsevTriangles = chelyuskintsevGeometry.getIndex()!.count / 3;
    expect(gorkyTriangles).toBeGreaterThan(500);
    expect(chelyuskintsevTriangles).toBeGreaterThan(400);
    expect(gorkyTriangles).toBeLessThan(FERRIS_WHEEL_TRIANGLE_BUDGET);
    expect(chelyuskintsevTriangles).toBeLessThan(FERRIS_WHEEL_TRIANGLE_BUDGET);
    assertValidAttractionGeometry(gorkyGeometry, 'Gorky wheel');
    assertValidAttractionGeometry(chelyuskintsevGeometry, 'Chelyuskintsev wheel');
  });

  it('merges two wheels additively', () => {
    const single = triangleCountFor([gorky()]);
    const twoWheels = triangleCountFor([gorky(), chelyuskintsev()]);
    expect(twoWheels).toBe(single + triangleCountFor([chelyuskintsev()]));
  });

  it('reaches the advertised total height (within ±1 m)', () => {
    for (const attraction of [gorky(), chelyuskintsev()]) {
      const geometry = buildAttractionGeometry([attraction])!;
      const box = bounds(geometry);
      expect(box.max[1]).toBeGreaterThan(attraction.height - 1);
      expect(box.max[1]).toBeLessThan(attraction.height + 1);
      // Nothing is buried under the ground plane.
      expect(box.min[1]).toBeGreaterThanOrEqual(-0.01);
    }
  });

  it('keeps the highest rim vertex at hubHeight + radius + tube radius', () => {
    const attraction = gorky();
    const box = bounds(buildAttractionGeometry([attraction])!);
    const expected = attraction.hubHeight + attraction.radius;
    expect(box.max[1]).toBeGreaterThan(expected + 0.1);
    expect(box.max[1]).toBeLessThan(expected + 0.5);
  });

  it('is deterministic: two builds are byte-identical', () => {
    const first = buildAttractionGeometry([gorky(), chelyuskintsev()])!;
    const second = buildAttractionGeometry([gorky(), chelyuskintsev()])!;
    expect(second.getIndex()!.count).toBe(first.getIndex()!.count);
    expect(Array.from(second.getAttribute('position').array as Float32Array)).toEqual(
      Array.from(first.getAttribute('position').array as Float32Array),
    );
    expect(Array.from(second.getAttribute('normal').array as Float32Array)).toEqual(
      Array.from(first.getAttribute('normal').array as Float32Array),
    );
    expect(Array.from(second.getAttribute('color').array as Float32Array)).toEqual(
      Array.from(first.getAttribute('color').array as Float32Array),
    );
  });
});

describe('cabins', () => {
  it('reflects the cabin count in the geometry', () => {
    const withoutCabins = triangleCountFor([gorky({ cabins: 0 })]);
    const withCabins = triangleCountFor([gorky({ cabins: 36 })]);
    expect(withCabins - withoutCabins).toBe(36 * FERRIS_WHEEL_CABIN_TRIANGLES);
    expect(triangleCountFor([gorky({ cabins: 18 })]) - withoutCabins).toBe(
      18 * FERRIS_WHEEL_CABIN_TRIANGLES,
    );
  });

  it('emits exactly one upright cabin box per cabin', () => {
    const attraction = gorky();
    const geometry = buildAttractionGeometry([attraction])!;
    const cabinTriangles = readTriangles(geometry).filter((triangle) =>
      isCabinTriangle(triangle, attraction),
    );
    expect(cabinTriangles.length).toBe(attraction.cabins! * FERRIS_WHEEL_CABIN_TRIANGLES);

    // Upright cabins: 8 vertical side triangles + 2 upward-facing roof
    // triangles per cabin, no tilted faces.
    const roofTriangles = cabinTriangles.filter((triangle) => triangle.normal[1] > 0.9).length;
    const sideTriangles = cabinTriangles.filter(
      (triangle) => Math.abs(triangle.normal[1]) < 0.01,
    ).length;
    expect(roofTriangles).toBe(attraction.cabins! * 2);
    expect(sideTriangles).toBe(attraction.cabins! * 8);
  });

  it('paints cream roofs on closed cabins and yellow bodies on open cabins', () => {
    const attraction = gorky({ openCabins: 4 });
    const geometry = buildAttractionGeometry([attraction])!;
    const closedCabins = attraction.cabins! - 4;
    // GeometrySink stores 6 vertices per quad (2 triangles), so a single
    // cabin face contributes 6 vertices of its colour.
    // Base yellow only appears on the +U face of open cabins.
    expect(countColoredVertices(geometry, FERRIS_WHEEL_COLORS.yellow)).toBe(4 * 6);
    // Base cream only appears on closed-cabin roof quads (one quad each).
    expect(countColoredVertices(geometry, CABIN_ROOF_CREAM)).toBe(closedCabins * 6);
  });

  it('has no yellow cabins when openCabins is zero', () => {
    const geometry = buildAttractionGeometry([gorky({ openCabins: 0 })])!;
    expect(countColoredVertices(geometry, FERRIS_WHEEL_COLORS.yellow)).toBe(0);
    // All 36 cabins then use red body shades.
    expect(CABIN_RED_SHADES.length).toBe(4);
    expect(CABIN_YELLOW_SHADES.length).toBe(4);
  });
});

describe('wheel orientation', () => {
  it('keeps the wheel disc in the plane given by rotation', () => {
    const attraction = gorky();
    const geometry = buildAttractionGeometry([attraction])!;
    const frame = ferrisWheelAxes(attraction.rotation);
    const positions = geometry.getAttribute('position').array as Float32Array;
    const hubX = attraction.x;
    const hubZ = -attraction.y;
    let minU = Infinity;
    let maxU = -Infinity;
    let minA = Infinity;
    let maxA = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const dx = positions[i] - hubX;
      const dz = positions[i + 2] - hubZ;
      const u = dx * frame.ux + dz * frame.uz;
      const a = dx * frame.ax + dz * frame.az;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minA = Math.min(minA, a);
      maxA = Math.max(maxA, a);
    }
    const spanU = maxU - minU;
    const spanA = maxA - minA;
    // The wheel disc is ~2·radius wide along the plane, a few metres thin
    // along the axle.
    expect(spanU).toBeGreaterThan(2 * attraction.radius - 2);
    expect(spanA).toBeLessThan(0.4 * attraction.radius);
  });

  it('rotates the whole model when the bearing changes', () => {
    const east = gorky({ rotation: 0 });
    const north = gorky({ rotation: Math.PI / 2 });
    const eastBox = bounds(buildAttractionGeometry([east])!);
    const northBox = bounds(buildAttractionGeometry([north])!);
    const eastSpanX = eastBox.max[0] - eastBox.min[0];
    const eastSpanZ = eastBox.max[2] - eastBox.min[2];
    const northSpanX = northBox.max[0] - northBox.min[0];
    const northSpanZ = northBox.max[2] - northBox.min[2];
    expect(eastSpanX).toBeGreaterThan(2 * east.radius * 0.95);
    expect(eastSpanZ).toBeLessThan(0.4 * east.radius);
    // A 90° plane rotation swaps the world X/Z extents.
    expect(northSpanX).toBeCloseTo(eastSpanZ, 3);
    expect(northSpanZ).toBeCloseTo(eastSpanX, 3);
  });
});

describe('vertex colours', () => {
  it('uses the real-wheel palette', () => {
    const geometry = buildAttractionGeometry([gorky()])!;
    for (const hex of [
      FERRIS_WHEEL_COLORS.frame,
      FERRIS_WHEEL_COLORS.red,
      FERRIS_WHEEL_COLORS.metal,
      FERRIS_WHEEL_COLORS.concrete,
      FERRIS_WHEEL_COLORS.dark,
    ]) {
      expect(countColoredVertices(geometry, hex), `colour ${hex} present`).toBeGreaterThan(0);
    }
    expect(CABIN_RED_SHADES).toHaveLength(4);
  });
});

describe('malformed attractions', () => {
  it('skips invalid attractions without throwing', () => {
    const invalid = [
      gorky({ radius: NaN }),
      gorky({ radius: -5 }),
      gorky({ hubHeight: Infinity }),
      gorky({ cabins: NaN }),
      gorky({ rotation: NaN }),
      gorky({ type: 'other' as unknown as AttractionFeature['type'] }),
      null as unknown as AttractionFeature,
      undefined as unknown as AttractionFeature,
    ];
    expect(() => buildAttractionGeometry(invalid)).not.toThrow();
    expect(buildAttractionGeometry(invalid)).toBeNull();

    const mixed = [gorky(), ...invalid];
    expect(() => buildAttractionGeometry(mixed)).not.toThrow();
    expect(triangleCountFor(mixed)).toBe(triangleCountFor([gorky()]));
  });

  it('reports skipped attractions through emitAttractions', () => {
    const sink = new GeometrySink();
    const stats = emitAttractions(sink, [gorky(), chelyuskintsev({ radius: NaN })]);
    expect(stats.attractions).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.triangles).toBeGreaterThan(0);
    expect(sink.triangleCount).toBe(stats.triangles);
  });
});

describe('environmentMeshes integration', () => {
  function makeTile(attractions?: AttractionFeature[]): TileData {
    return {
      tileX: 2,
      tileY: -1,
      bounds: [1024, -512, 1536, 0],
      buildings: [],
      surfaces: [],
      roads: [],
      trees: [],
      attractions,
    };
  }

  it('returns merged attraction geometry and counts', () => {
    const tile = makeTile([gorky(), chelyuskintsev()]);
    const result = buildEnvironmentMeshes(tile, { tileBounds: tile.bounds, trees: true });
    expect(result.attractions).toBeTruthy();
    expect(result.counts!.attractions).toBe(2);
    expect(result.counts!.attractionTriangles).toBeGreaterThan(0);
    expect(result.triangleCount).toBe(
      result.counts!.groundTriangles +
        result.counts!.roadTriangles +
        result.counts!.treeTriangles +
        result.counts!.attractionTriangles,
    );
    assertValidAttractionGeometry(result.attractions!, 'merged attractions');
    expect(result.attractions!.getIndex()!.count / 3).toBe(result.counts!.attractionTriangles);
  });

  it('returns null / zero counts for tiles without attractions', () => {
    const tile = makeTile(undefined);
    const result = buildEnvironmentMeshes(tile, { tileBounds: tile.bounds, trees: true });
    expect(result.attractions ?? null).toBeNull();
    expect(result.counts!.attractions).toBe(0);
    expect(result.counts!.attractionTriangles).toBe(0);
  });
});
