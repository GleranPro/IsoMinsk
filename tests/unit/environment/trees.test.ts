import { describe, expect, it } from 'vitest';
import type { TreeInstance } from '../../../src/shared/types';
import {
  TREE_FULL_MAX,
  TREE_LOD_MAX,
  TREE_SIMPLE_MAX,
  TREE_TRIANGLES_DENSE,
  TREE_TRIANGLES_FULL,
  TREE_TRIANGLES_LOD,
  TREE_TRIANGLES_SIMPLE,
  buildTreeGeometry,
  treeDetailTier,
} from '../../../src/city/environment/treeMeshes';

function makeTree(x: number, y: number, overrides: Partial<TreeInstance> = {}): TreeInstance {
  return {
    x,
    y,
    height: 8,
    radius: 3,
    variation: 0.5,
    mapped: true,
    ...overrides,
  };
}

function positionArray(geometry: {
  getAttribute: (name: string) => { array: ArrayLike<number>; count: number } | undefined;
}): Float32Array {
  const attribute = geometry.getAttribute('position');
  if (!attribute) throw new Error('geometry has no position attribute');
  return new Float32Array(attribute.array as ArrayLike<number>);
}

describe('buildTreeGeometry', () => {
  it('returns null when there are no trees', () => {
    expect(buildTreeGeometry([])).toBeNull();
    expect(buildTreeGeometry(null)).toBeNull();
    expect(buildTreeGeometry(undefined)).toBeNull();
  });

  it('emits the expected triangle count for N trees', () => {
    const trees = [
      makeTree(10, 20),
      makeTree(40, 20, { height: 12, radius: 4.5, variation: 0.1 }),
      makeTree(70, 20, { height: 5, radius: 1.8, variation: 0.9 }),
      makeTree(100, 20, { mapped: false }),
      makeTree(130, 20, { variation: 0 }),
    ];
    const result = buildTreeGeometry(trees)!;
    expect(result).not.toBeNull();
    expect(result.lod).toBe(false);
    expect(result.count).toBe(5);
    expect(result.trianglesPerTree).toBe(TREE_TRIANGLES_FULL);
    expect(result.triangleCount).toBe(5 * TREE_TRIANGLES_FULL);
    expect(result.geometry.getIndex()!.count).toBe(5 * TREE_TRIANGLES_FULL * 3);
  });

  it('keeps every tree inside a sane bounding box above the ground', () => {
    const trees = [
      makeTree(-120, 340, { height: 9, radius: 3.5 }),
      makeTree(15, -20, { height: 4, radius: 1.5, variation: 0.2 }),
      makeTree(250, 80, { height: 14, radius: 6, variation: 0.8 }),
    ];
    for (const tree of trees) {
      const result = buildTreeGeometry([tree])!;
      const positions = positionArray(result.geometry);
      const maxRadius = tree.radius * 1.1;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        const wx = positions[i];
        const wy = positions[i + 1];
        const wz = positions[i + 2];
        expect(Number.isFinite(wx)).toBe(true);
        expect(Number.isFinite(wy)).toBe(true);
        expect(Number.isFinite(wz)).toBe(true);
        // world = [localX, height, -localY]
        expect(wx).toBeGreaterThanOrEqual(tree.x - maxRadius);
        expect(wx).toBeLessThanOrEqual(tree.x + maxRadius);
        expect(wz).toBeGreaterThanOrEqual(-tree.y - maxRadius);
        expect(wz).toBeLessThanOrEqual(-tree.y + maxRadius);
        expect(wy).toBeGreaterThanOrEqual(-1e-6);
        expect(wy).toBeLessThanOrEqual(tree.height + 1e-6);
        minY = Math.min(minY, wy);
        maxY = Math.max(maxY, wy);
      }
      expect(minY).toBeGreaterThanOrEqual(-1e-6);
      // Canopy reaches the nominal tree height.
      expect(maxY).toBeGreaterThan(tree.height * 0.9);
    }
  });

  it('uses vertex colours for trunk and canopy; no aColor attribute', () => {
    const dark = buildTreeGeometry([makeTree(0, 0, { variation: 0 })])!;
    const light = buildTreeGeometry([makeTree(0, 0, { variation: 0.99 })])!;
    for (const result of [dark, light]) {
      expect(result.geometry.getAttribute('color')).toBeTruthy();
      // Option A: standard Three vertex colours are the single authoritative
      // colour path; the environment material must not multiply aColor too.
      expect(result.geometry.getAttribute('aColor')).toBeUndefined();
      const colors = result.geometry.getAttribute('color').array as Float32Array;
      let allFinite = true;
      for (let i = 0; i < colors.length; i++) if (!Number.isFinite(colors[i])) allFinite = false;
      expect(allFinite).toBe(true);
    }
    const darkColors = Array.from(dark.geometry.getAttribute('color').array as Float32Array);
    const lightColors = Array.from(light.geometry.getAttribute('color').array as Float32Array);
    expect(darkColors).not.toEqual(lightColors);
  });

  it('is deterministic: same instances produce identical geometry', () => {
    const trees = [makeTree(5, 6, { variation: 0.37 }), makeTree(-30, 90, { variation: 0.71 })];
    const first = buildTreeGeometry(trees)!;
    const second = buildTreeGeometry(trees)!;
    expect(first.triangleCount).toBe(second.triangleCount);
    expect(Array.from(positionArray(first.geometry))).toEqual(Array.from(positionArray(second.geometry)));
  });

  it('tiers detail deterministically by tile tree count', () => {
    expect(treeDetailTier(0)).toBe('full');
    expect(treeDetailTier(TREE_FULL_MAX)).toBe('full');
    expect(treeDetailTier(TREE_FULL_MAX + 1)).toBe('lod');
    expect(treeDetailTier(TREE_LOD_MAX)).toBe('lod');
    expect(treeDetailTier(TREE_LOD_MAX + 1)).toBe('simple');
    expect(treeDetailTier(TREE_SIMPLE_MAX)).toBe('simple');
    expect(treeDetailTier(TREE_SIMPLE_MAX + 1)).toBe('dense');
  });

  const tiers: Array<{ count: number; tier: 'full' | 'lod' | 'simple' | 'dense'; tris: number }> = [
    { count: 5, tier: 'full', tris: TREE_TRIANGLES_FULL },
    { count: TREE_LOD_MAX, tier: 'lod', tris: TREE_TRIANGLES_LOD },
    { count: TREE_SIMPLE_MAX, tier: 'simple', tris: TREE_TRIANGLES_SIMPLE },
    { count: TREE_SIMPLE_MAX + 100, tier: 'dense', tris: TREE_TRIANGLES_DENSE },
  ];
  for (const scenario of tiers) {
    it(`emits ${scenario.tris} triangles/tree at the ${scenario.tier} tier`, () => {
      const trees: TreeInstance[] = [];
      for (let i = 0; i < scenario.count; i++) {
        trees.push(makeTree(i * 3, i * 2, { variation: (i % 10) / 10 }));
      }
      const result = buildTreeGeometry(trees)!;
      expect(result.tier).toBe(scenario.tier);
      expect(result.trianglesPerTree).toBe(scenario.tris);
      expect(result.count).toBe(scenario.count);
      expect(result.triangleCount).toBe(scenario.count * scenario.tris);
      expect(result.trianglesPerTree).toBeLessThan(60);
      // Total merged tile tree geometry stays under the 12000-triangle budget.
      expect(result.triangleCount).toBeLessThan(12000);
    });
  }

  it('skips malformed instances without throwing', () => {
    const trees = [
      makeTree(0, 0),
      makeTree(NaN, 0),
      makeTree(0, Infinity),
      makeTree(10, 10, { height: NaN }),
      makeTree(20, 20, { radius: NaN }),
      makeTree(30, 30, { height: -5, radius: -2 }),
    ];
    const result = buildTreeGeometry(trees)!;
    expect(result).not.toBeNull();
    // The last (negative dims) tree is clamped to sensible values and emitted.
    expect(result.count).toBe(2);
    expect(result.triangleCount).toBe(2 * TREE_TRIANGLES_FULL);
  });
});
