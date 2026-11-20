import { describe, expect, it } from 'vitest';

import { collectLampSpots, LAMP_SPACING_M } from '../../../src/city/environment/lampSpots';
import type { TileData } from '../../../src/shared/types';

function makeTile(overrides: Partial<TileData> = {}): TileData {
  return {
    tileX: 0,
    tileY: 0,
    bounds: [0, 0, 1024, 1024],
    buildings: [],
    surfaces: [],
    roads: [],
    trees: [],
    ground: { version: 4, strokes: [] },
    ...overrides,
  };
}

describe('collectLampSpots', () => {
  it('returns null for a tile without strokes', () => {
    expect(collectLampSpots(makeTile())).toBeNull();
  });

  it('places lamps along a major road, phase-locked to the absolute arc', () => {
    // Straight east-west primary road crossing the whole tile at y = 512.
    const tile = makeTile({
      ground: {
        version: 4,
        strokes: [
          { k: 'road', c: 'primary', w: 12, p: [0, 512, 1024, 512], s0: 0, r: 2 },
        ],
      },
    });
    const spots = collectLampSpots(tile);
    expect(spots).not.toBeNull();
    const xs: number[] = [];
    for (let i = 0; i < spots!.length; i += 2) xs.push(spots![i]);
    expect(xs.length).toBeGreaterThanOrEqual(20);
    // Consecutive lamps are one spacing apart.
    for (let i = 1; i < xs.length; i += 1) {
      expect(Math.abs(xs[i] - xs[i - 1])).toBeCloseTo(LAMP_SPACING_M, 3);
    }
    // Lamps stand at the roadside (world z = -y, so the road is at z = -512):
    // the distance to the centreline is the same for every lamp and the side
    // alternates.
    const offsets = [] as number[];
    for (let i = 0; i < spots!.length; i += 2) {
      offsets.push(Math.abs(spots![i + 1] - -512));
    }
    for (const offset of offsets) {
      expect(offset).toBeGreaterThan(5);
      expect(offset).toBeLessThan(9);
    }
    const signed = [] as number[];
    for (let i = 0; i < spots!.length; i += 2) signed.push(Math.sign(spots![i + 1] - -512));
    for (let i = 1; i < signed.length; i += 1) {
      expect(signed[i]).not.toBe(signed[i - 1]);
    }
  });

  it('skips minor classes, footways and bridge strokes', () => {
    const tile = makeTile({
      ground: {
        version: 4,
        strokes: [
          { k: 'road', c: 'residential', w: 8, p: [0, 100, 1024, 100], s0: 0, r: 4 },
          { k: 'path', c: 'footway', w: 3, p: [0, 200, 1024, 200], s0: 0, r: 5 },
          { k: 'road', c: 'primary', w: 12, p: [0, 300, 1024, 300], s0: 0, r: 2, b: 1 },
        ],
      },
    });
    expect(collectLampSpots(tile)).toBeNull();
  });

  it('gives every lamp to exactly one tile of a two-tile row (no duplicates in the shared band)', () => {
    // One stroke crossing two tiles side by side; each tile sees the same
    // stroke (64 m margin). Phase-locked arcs + half-open bounds must not
    // emit any position twice.
    const stroke = { k: 'road' as const, c: 'primary' as const, w: 12, p: [-64, 512, 1088, 512], s0: 100, r: 2 };
    const left = collectLampSpots(makeTile({ bounds: [0, 0, 1024, 1024], ground: { version: 4, strokes: [stroke] } }));
    const right = collectLampSpots(
      makeTile({ tileX: 1, bounds: [1024, 0, 2048, 1024], ground: { version: 4, strokes: [stroke] } }),
    );
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    const seen = new Set<string>();
    for (const spots of [left!, right!]) {
      for (let i = 0; i < spots.length; i += 2) {
        const key = `${spots[i].toFixed(2)}:${spots[i + 1].toFixed(2)}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});
