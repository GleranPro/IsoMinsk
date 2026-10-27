/**
 * Isometric Minsk — unit tests for the tile grid + coordinate math.
 *
 * Contract under test: src/shared/tileMath.ts (and the TILE_SIZE_M default from
 * src/shared/config.ts). These are pure functions shared by the Python-derived
 * tile pipeline and the renderer, so a regression here breaks both.
 *
 * Run: pnpm test -- tests/unit/tile_math.test.ts
 */

import { describe, expect, it } from 'vitest';
import { TILE_SIZE_M } from '../../src/shared/config';
import {
  boundsIntersect,
  distanceSq2D,
  emptyTile,
  localToTile,
  localToWorld,
  polygonArea,
  polygonBounds,
  ringArea,
  ringBounds,
  tileBounds,
  tileContains,
  tileFileName,
  tileKey,
  tilesInRect,
  worldToLocal,
} from '../../src/shared/tileMath';
import type { Ring } from '../../src/shared/types';

/** Deterministic pseudo-random generator so property tests are reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

describe('tileMath — localToTile / tileBounds', () => {
  it('maps local metres to tile indices with floor semantics', () => {
    expect(localToTile(0, 0)).toEqual({ x: 0, y: 0 });
    expect(localToTile(511.999, 511.999)).toEqual({ x: 0, y: 0 });
    expect(localToTile(512, 512)).toEqual({ x: 1, y: 1 });
    expect(localToTile(1023.5, 1023.5)).toEqual({ x: 1, y: 1 });
    expect(localToTile(1024, 0)).toEqual({ x: 2, y: 0 });
  });

  it('handles negative coordinates (tiles south-west of the origin)', () => {
    expect(localToTile(-0.001, -0.001)).toEqual({ x: -1, y: -1 });
    expect(localToTile(-1, -1)).toEqual({ x: -1, y: -1 });
    expect(localToTile(-512, -512)).toEqual({ x: -1, y: -1 });
    expect(localToTile(-512.5, -512.5)).toEqual({ x: -2, y: -2 });
  });

  it('honours a custom tile size', () => {
    expect(localToTile(99.9, 250, 100)).toEqual({ x: 0, y: 2 });
    expect(localToTile(100, 200, 100)).toEqual({ x: 1, y: 2 });
    expect(tileBounds(2, -1, 100)).toEqual([200, -100, 300, 0]);
  });

  it('tileBounds is the half-open [min, max) cell for that index', () => {
    expect(tileBounds(0, 0)).toEqual([0, 0, TILE_SIZE_M, TILE_SIZE_M]);
    expect(tileBounds(1, 1)).toEqual([512, 512, 1024, 1024]);
    expect(tileBounds(-1, -1)).toEqual([-512, -512, 0, 0]);
    expect(tileBounds(3, -2)).toEqual([3 * 512, -2 * 512, 4 * 512, -1 * 512]);
  });

  it('round-trips every sampled point: point -> tile -> bounds contain the point', () => {
    const random = makeRandom(0xa11ce);
    for (let i = 0; i < 500; i += 1) {
      const x = (random() - 0.5) * 10_000;
      const y = (random() - 0.5) * 10_000;
      const tile = localToTile(x, y);
      expect(tileContains(tile, x, y)).toBe(true);
      const [minX, minY, maxX, maxY] = tileBounds(tile.x, tile.y);
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(y).toBeGreaterThanOrEqual(minY);
      expect(x).toBeLessThan(maxX);
      expect(y).toBeLessThan(maxY);
    }
  });

  it('tileContains uses half-open bounds (max edge belongs to the next tile)', () => {
    expect(tileContains({ x: 0, y: 0 }, 0, 0)).toBe(true);
    expect(tileContains({ x: 0, y: 0 }, 511.999, 511.999)).toBe(true);
    expect(tileContains({ x: 0, y: 0 }, 512, 512)).toBe(false);
    expect(tileContains({ x: 1, y: 1 }, 512, 512)).toBe(true);
  });

  it('produces stable keys and tile file names', () => {
    expect(tileKey(0, 0)).toBe('0_0');
    expect(tileKey(3, -2)).toBe('3_-2');
    expect(tileFileName(3, -2)).toBe('tiles/3_-2.json');
  });
});

describe('tileMath — tilesInRect', () => {
  it('returns a single tile for a small rectangle inside one tile', () => {
    expect(tilesInRect(10, 10, 20, 20)).toEqual([{ x: 0, y: 0 }]);
  });

  it('returns all four tiles when a rectangle crosses the origin', () => {
    const tiles = tilesInRect(-10, -10, 10, 10);
    expect(tiles).toHaveLength(4);
    expect(tiles).toEqual(
      expect.arrayContaining([
        { x: -1, y: -1 },
        { x: 0, y: -1 },
        { x: -1, y: 0 },
        { x: 0, y: 0 },
      ]),
    );
  });

  it('returns every tile crossing a 2x2 rectangle', () => {
    const tiles = tilesInRect(500, 500, 530, 530);
    expect(tiles).toHaveLength(4);
    expect(tiles).toEqual(
      expect.arrayContaining([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ]),
    );
    expect(new Set(tiles.map((tile) => tileKey(tile.x, tile.y))).size).toBe(tiles.length);
  });

  it('covers rectangles in negative space', () => {
    // -600..-550 lies entirely inside tile (-2, -2): floor(-600/512) = -2.
    expect(tilesInRect(-600, -600, -550, -550)).toEqual([{ x: -2, y: -2 }]);
    // A rectangle spanning -600..-500 crosses into tile (-1, -1).
    expect(tilesInRect(-600, -600, -500, -500)).toHaveLength(4);
  });
});

describe('tileMath — local <-> world conversion', () => {
  it('maps north to negative Z and height to Y', () => {
    expect(localToWorld(10, 20, 3)).toEqual([10, 3, -20]);
    expect(localToWorld(-5, 0, 0)).toEqual([-5, 0, -0]);
  });

  it('round-trips through worldToLocal', () => {
    const random = makeRandom(0xbeef);
    for (let i = 0; i < 200; i += 1) {
      const x = (random() - 0.5) * 4000;
      const y = (random() - 0.5) * 4000;
      const height = random() * 100;
      const [wx, wy, wz] = localToWorld(x, y, height);
      const [lx, ly, lh] = worldToLocal(wx, wy, wz);
      expect(lx).toBeCloseTo(x, 9);
      expect(ly).toBeCloseTo(height, 9);
      expect(lh).toBeCloseTo(y, 9);
      // Y is preserved untouched by the mapping.
      expect(wy).toBe(height);
    }
  });
});

describe('tileMath — ring/polygon measurements', () => {
  const unitSquareCCW: Ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const unitSquareCW: Ring = [...unitSquareCCW].reverse();

  it('ringArea magnitude matches the known area', () => {
    expect(Math.abs(ringArea(unitSquareCCW))).toBeCloseTo(1, 9);
    expect(Math.abs(ringArea([[0, 0], [2, 0], [0, 2]]))).toBeCloseTo(2, 9);
    expect(Math.abs(ringArea([[0, 0], [10, 0], [10, 10], [0, 10]]))).toBeCloseTo(100, 9);
  });

  it('reversing the winding flips the sign of ringArea', () => {
    expect(ringArea(unitSquareCW)).toBeCloseTo(-ringArea(unitSquareCCW), 9);
  });

  it('polygonArea subtracts holes and never returns a negative area', () => {
    const outer: Ring = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const hole: Ring = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
    ];
    expect(polygonArea([outer])).toBeCloseTo(100, 9);
    expect(polygonArea([outer, hole])).toBeCloseTo(96, 9);
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([unitSquareCCW, unitSquareCCW])).toBeCloseTo(0, 9);
  });

  it('ringBounds and polygonBounds return the axis-aligned extent', () => {
    expect(ringBounds(unitSquareCCW)).toEqual([0, 0, 1, 1]);
    expect(ringBounds([[-3, 5], [2, -7], [0, 0]])).toEqual([-3, -7, 2, 5]);
    expect(polygonBounds([unitSquareCCW])).toEqual([0, 0, 1, 1]);
    expect(polygonBounds([])).toEqual([0, 0, 0, 0]);
  });
});

describe('tileMath — bounds intersection and distances', () => {
  it('detects overlapping, touching, contained and disjoint bounds', () => {
    const a: [number, number, number, number] = [0, 0, 10, 10];
    expect(boundsIntersect(a, [5, 5, 15, 15])).toBe(true); // overlap
    expect(boundsIntersect(a, [10, 10, 20, 20])).toBe(true); // touching corner
    expect(boundsIntersect(a, [2, 2, 3, 3])).toBe(true); // contained
    expect(boundsIntersect(a, [11, 0, 20, 10])).toBe(false); // disjoint in X
    expect(boundsIntersect(a, [0, 11, 10, 20])).toBe(false); // disjoint in Y
    // boundsIntersect is symmetric.
    expect(boundsIntersect(a, [5, -5, 15, 5])).toBe(boundsIntersect([5, -5, 15, 5], a));
  });

  it('distanceSq2D computes squared planar distance', () => {
    expect(distanceSq2D(0, 0, 3, 4)).toBe(25);
    expect(distanceSq2D(3, 4, 0, 0)).toBe(25);
    expect(distanceSq2D(-1, -1, -1, -1)).toBe(0);
  });
});

describe('tileMath — emptyTile', () => {
  it('builds a valid, serialisable empty tile payload', () => {
    const tile = emptyTile(2, -3);
    expect(tile.tileX).toBe(2);
    expect(tile.tileY).toBe(-3);
    expect(tile.bounds).toEqual([2 * 512, -3 * 512, 3 * 512, -2 * 512]);
    expect(tile.buildings).toEqual([]);
    expect(tile.surfaces).toEqual([]);
    expect(tile.roads).toEqual([]);
    expect(tile.trees).toEqual([]);
    expect(() => JSON.stringify(tile)).not.toThrow();
    expect(JSON.parse(JSON.stringify(tile))).toEqual(tile);
  });
});
