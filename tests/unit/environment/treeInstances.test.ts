import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildTreeInstances, createCrownTemplate, createTrunkTemplate, crownTriangles,
  createWinterCrownTemplate, MAX_INSTANCED_TREES_PER_TILE, resolveTreeStyle, TREE_STYLES,
  treeInstanceBytes } from '../../../src/city/environment/treeInstances';
import type { TreeInstance } from '../../../src/shared/types';
import type { TreeDetailTier } from '../../../src/city/environment/treeMeshes';

const tree = (i = 0, change: Partial<TreeInstance> = {}): TreeInstance =>
  ({ x: 200 + i * 3, y: -100 + i, height: 12, radius: 4, variation: i * 0.137 % 1, mapped: true, ...change });
const triangles = (g: THREE.BufferGeometry) => (g.index?.count ?? g.getAttribute('position').count) / 3;

describe('instanced vegetation data', () => {
  it('defaults to the selected asymmetric style, retaining explicit QA comparison', () => {
    expect(resolveTreeStyle(undefined)).toBe('asymmetric');
    expect(resolveTreeStyle('unknown')).toBe('asymmetric');
    expect(resolveTreeStyle('legacy')).toBe('legacy');
    for (const style of TREE_STYLES) expect(resolveTreeStyle(style)).toBe(style);
  });

  it('handles empty, invalid and clamped data without changing valid positions', () => {
    expect(buildTreeInstances(null, 'clustered')).toBeNull();
    expect(buildTreeInstances([], 'clustered')).toBeNull();
    expect(buildTreeInstances([tree(0, { x: NaN })], 'clustered')).toBeNull();
    const result = buildTreeInstances([null as unknown as TreeInstance, tree(0, { x: NaN }),
      tree(1, { height: Infinity }), tree(2, { radius: NaN }), tree(3, { height: -3, radius: -1, variation: NaN }),
      tree(4, { height: 90, radius: 80, variation: 2 })], 'clustered')!;
    expect(result.count).toBe(2);
    expect(result.trunks.matrices[12]).toBe(209);
    expect(result.trunks.matrices[14]).toBe(97);
    expect(result.trunks.variations[0]).toBe(0);
    expect(result.trunks.variations[1]).toBe(1);
    for (const batch of [result.trunks, ...result.crowns]) {
      expect([...batch.matrices, ...batch.colors].every(Number.isFinite)).toBe(true);
      expect(batch.matrices.length).toBe(batch.count * 16);
      expect(batch.colors.length).toBe(batch.count * 3);
    }
  });

  it('preserves deterministic transforms, palette values and partitioning', () => {
    const input = Array.from({ length: 159 }, (_, i) => tree(i));
    const first = buildTreeInstances(input, 'clustered')!;
    expect(buildTreeInstances(input, 'clustered')).toEqual(first);
    expect(first.crowns.reduce((n, b) => n + b.count, 0)).toBe(input.length);
    expect(first.crowns).toHaveLength(3);
    const byPosition = new Map(input.map(t => [t.x, t]));
    const cache = new Map<number, THREE.BufferGeometry>();
    for (const batch of first.crowns) {
      const geometry = createCrownTemplate(first.style, first.tier, batch.template);
      cache.set(batch.template, geometry);
      for (let i = 0; i < batch.count; i++) {
        const matrix = new THREE.Matrix4().fromArray(batch.matrices, i * 16);
        const source = byPosition.get(matrix.elements[12])!;
        expect(matrix.elements[14]).toBe(-source.y);
        const p = geometry.getAttribute('position');
        let bottom = Infinity, top = -Infinity;
        for (let j = 0; j < p.count; j++) {
          const point = new THREE.Vector3().fromBufferAttribute(p, j).applyMatrix4(matrix);
          bottom = Math.min(bottom, point.y); top = Math.max(top, point.y);
          expect(Math.hypot(point.x - source.x, point.z + source.y)).toBeLessThanOrEqual(source.radius + 1e-5);
        }
        expect(bottom).toBeCloseTo(source.height * 0.34, 5);
        expect(top).toBeCloseTo(source.height, 5);
      }
    }
    for (const g of cache.values()) g.dispose();
  });

  it.each([[160, 'full'], [161, 'lod'], [320, 'lod'], [321, 'simple'], [600, 'simple'], [601, 'dense']] as const)(
    'preserves the density threshold at %i trees', (count, tier) => {
      const result = buildTreeInstances(Array.from({ length: count }, (_, i) => tree(i)), 'clustered')!;
      expect(result.tier).toBe(tier);
      expect(result.count).toBe(count);
      expect(result.triangleCount).toBe(count * (8 + crownTriangles(result.style, tier)));
    });

  it('splits crown batches by species and reads missing species as broadleaf', () => {
    const input = Array.from({ length: 60 }, (_, i) =>
      tree(i, i % 3 === 0 ? { species: 1 } : {}));
    const result = buildTreeInstances(input, 'clustered')!;
    expect(result.crowns.reduce((n, b) => n + b.count, 0)).toBe(input.length);
    expect(result.crowns.some(b => b.species === 1)).toBe(true);
    expect(result.crowns.some(b => b.species === 0)).toBe(true);
    for (const batch of result.crowns) {
      for (let i = 0; i < batch.count; i += 1) {
        const matrix = new THREE.Matrix4().fromArray(batch.matrices, i * 16);
        const source = input.find(t => Math.abs(t.x - matrix.elements[12]) < 1e-6)!;
        expect(batch.species).toBe(source.species === 1 ? 1 : 0);
      }
    }
    // Old tiles without the field produce only broadleaf batches.
    const legacy = buildTreeInstances(input.map(t => ({ ...t, species: undefined })), 'clustered')!;
    expect(legacy.crowns.every(b => b.species === 0)).toBe(true);
    expect(legacy.crowns).toHaveLength(3);
  });

  it('caps input before filtering and keeps transfer storage at 160 bytes/tree', () => {
    const input = Array.from({ length: MAX_INSTANCED_TREES_PER_TILE + 1 }, (_, i) => tree(i));
    const result = buildTreeInstances(input, 'clustered')!;
    expect(result.count).toBe(MAX_INSTANCED_TREES_PER_TILE);
    expect(treeInstanceBytes(result)).toBe(result.count * 160);
    input[0].x = NaN;
    expect(buildTreeInstances(input, 'clustered')!.count).toBe(MAX_INSTANCED_TREES_PER_TILE - 1);
  });
});

describe('winter branch templates', () => {
  for (const style of TREE_STYLES) for (const tier of ['full', 'lod', 'simple', 'dense'] as TreeDetailTier[]) {
    it(`${style}/${tier}: bare branches fit the crown triangle budget`, () => {
      for (let variant = 0; variant < 3; variant++) {
        const g = createWinterCrownTemplate(style, tier, variant);
        expect(triangles(g)).toBeLessThanOrEqual(crownTriangles(style, tier));
        expect(triangles(g)).toBeGreaterThanOrEqual(8);
        expect(g.boundingBox!.min.y).toBeCloseTo(0);
        expect(g.boundingBox!.max.y).toBeCloseTo(1);
        const p = g.getAttribute('position'), n = g.getAttribute('normal');
        for (let i = 0; i < p.count; i++) {
          expect(Math.hypot(p.getX(i), p.getZ(i))).toBeLessThanOrEqual(1 + 1e-6);
          const normal = new THREE.Vector3().fromBufferAttribute(n, i);
          expect(normal.length()).toBeCloseTo(1);
          // Normals are biased up so snow settles on the branches.
          expect(normal.y).toBeGreaterThan(0.8);
        }
        expect(g.getAttribute('color')).toBeDefined();
        const branch = g.getAttribute('aWinterBranch');
        expect(branch).toBeDefined();
        expect(branch.count).toBe(p.count);
        expect(branch.getX(0)).toBe(1);
        g.dispose();
      }
    });
  }

  it('uses a dark bark colour that reads against snow', () => {
    const g = createWinterCrownTemplate('asymmetric', 'full', 0);
    const color = g.getAttribute('color');
    const r = color.getX(0), green = color.getY(0), b = color.getZ(0);
    expect(r).toBeGreaterThan(0.02);
    expect(r).toBeLessThan(0.2);
    // Brown bark: red > green > blue.
    expect(r).toBeGreaterThan(green);
    expect(green).toBeGreaterThan(b);
    g.dispose();
  });
});

describe('shared tree templates', () => {
  it('builds an eight-triangle trunk', () => {
    const g = createTrunkTemplate();
    expect(triangles(g)).toBe(8);
    g.dispose();
  });

  for (const style of TREE_STYLES) for (const tier of ['full', 'lod', 'simple', 'dense'] as TreeDetailTier[]) {
    it(`${style}/${tier}: three bounded, indexed templates under 60 triangles/tree`, () => {
      const shapes: number[][] = [];
      for (let variant = 0; variant < 3; variant++) {
        const g = createCrownTemplate(style, tier, variant);
        expect(triangles(g)).toBe(crownTriangles(style, tier));
        expect(triangles(g) + 8).toBeLessThan(60);
        expect(g.boundingBox!.min.y).toBeCloseTo(0);
        expect(g.boundingBox!.max.y).toBeCloseTo(1);
        const p = g.getAttribute('position'), n = g.getAttribute('normal');
        for (let i = 0; i < p.count; i++) {
          expect(Math.hypot(p.getX(i), p.getZ(i))).toBeLessThanOrEqual(1 + 1e-6);
          expect(new THREE.Vector3().fromBufferAttribute(n, i).length()).toBeCloseTo(1);
        }
        expect(g.index).not.toBeNull();
        expect(p.count).toBeLessThan(triangles(g) * 3);
        shapes.push(Array.from(p.array));
        g.dispose();
      }
      expect(shapes[0]).not.toEqual(shapes[1]);
      expect(shapes[1]).not.toEqual(shapes[2]);
    });
  }
});
