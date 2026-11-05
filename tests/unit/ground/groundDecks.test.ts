import { describe, expect, it } from 'vitest';
import {
  DECK_BASE_Y,
  DECK_SLAB_M,
  PARAPET_HEIGHT_M,
  buildDeckTopGeometry,
  emitDeckSides,
  layoutDeckAtlas,
  tileDecks,
  usesGroundDecks,
} from '../../../src/city/ground/groundDecks';
import { GeometrySink } from '../../../src/city/environment/meshBuilder';
import type { GroundDeck, TileData } from '../../../src/shared/types';

/** 20 × 10 m deck, CCW: ends at x = 0 and x = 20, sides along y = 0 / y = 10. */
function deck(overrides: Partial<GroundDeck> = {}): GroundDeck {
  return {
    id: 1,
    bb: [0, 0, 20, 10],
    hz: 3,
    // Two triangles, CCW from above; z 0 at x = 0, 3 at x = 20.
    t: [0, 0, 0, 20, 0, 3, 20, 10, 3, 0, 0, 0, 20, 10, 3, 0, 10, 0],
    r: [
      {
        p: [0, 0, 20, 0, 20, 10, 0, 10],
        z: [0, 3, 3, 0],
        // edge 0: south side, 1: east (cut), 2: north side, 3: west end
        e: [1, 2, 1, 0],
      },
    ],
    s: [],
    ...overrides,
  };
}

describe('bridge decks (payload 0.4.2)', () => {
  it('only ground version 2 tiles use the deck path', () => {
    expect(usesGroundDecks({ ground: { version: 2, strokes: [] } } as unknown as TileData)).toBe(true);
    expect(usesGroundDecks({ ground: { version: 1, strokes: [] } } as unknown as TileData)).toBe(false);
    expect(usesGroundDecks(null)).toBe(false);
  });

  it('drops malformed decks', () => {
    const tile = {
      ground: { version: 2, strokes: [], decks: [deck(), deck({ t: [0, 0, Number.NaN, 1, 1, 1, 2, 2, 2] }), deck({ t: [1, 2] })] },
    } as unknown as TileData;
    expect(tileDecks(tile)).toHaveLength(1);
  });

  it('lays decks out in a world-anchored atlas', () => {
    const res = 0.5;
    const layout = layoutDeckAtlas([deck(), deck({ bb: [100.2, 50, 110, 60] })], res);
    expect(layout.rects).toHaveLength(2);
    for (const rect of layout.rects) {
      // Texel origin on the world texel grid (same grid as the ground texture).
      expect(Number.isInteger(rect.x0 / res)).toBe(true);
      expect(Number.isInteger(rect.y1 / res)).toBe(true);
    }
    const [a, b] = layout.rects;
    const [wa] = layout.sizes[0];
    expect(a.ay === b.ay ? Math.abs(a.ax - b.ax) >= wa || Math.abs(a.ax - b.ax) >= layout.sizes[1][0] : true).toBe(true);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('builds the top surface at deck height with flat normals and atlas UVs', () => {
    const d = deck();
    const res = 0.5;
    const layout = layoutDeckAtlas([d], res);
    const geometry = buildDeckTopGeometry([d], { ...layout, res })!;
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    expect(pos.count).toBe(6);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // z (height) 0 at x = 0, 3 at x = 20.
      expect(y).toBeCloseTo(DECK_BASE_Y + (x > 10 ? 3 : 0), 5);
      expect(nor.getY(i)).toBe(1);
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeLessThanOrEqual(1);
    }
    // Front faces point up: (B − A) × (C − A) has +y.
    for (let i = 0; i < pos.count; i += 3) {
      const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
      const ux = pos.getX(i + 1) - ax, uy = pos.getY(i + 1) - ay, uz = pos.getZ(i + 1) - az;
      const vx = pos.getX(i + 2) - ax, vy = pos.getY(i + 2) - ay, vz = pos.getZ(i + 2) - az;
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
      void uy;
      void vy;
    }
  });

  it('puts fascia and parapet on side edges only, none on ends or cuts', () => {
    const sink = new GeometrySink();
    const stats = emitDeckSides(sink, [deck()]);
    expect(stats.sideEdges).toBe(2);
    expect(stats.endEdges).toBe(1);
    expect(stats.triangles).toBeGreaterThan(0);
    const geometry = sink.build();
    const pos = geometry.getAttribute('position');
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      // Nothing on the west end (x = 0) except the corners of the side edges,
      // nothing across the east cut (x = 20) except those corners.
      const x = pos.getX(i);
      const z = -pos.getZ(i);
      if (x < 1e-6 || x > 20 - 1e-6) expect(z < 0.5 || z > 9.5).toBe(true);
      maxY = Math.max(maxY, pos.getY(i));
    }
    expect(maxY).toBeCloseTo(DECK_BASE_Y + 3 + PARAPET_HEIGHT_M, 5);
  });

  it('leaves the gap under the span open (fascia stops a slab below the deck)', () => {
    const sink = new GeometrySink();
    // Flat 3 m deck: fascia from the parapet down to deck − slab, not to the ground.
    emitDeckSides(sink, [
      deck({ r: [{ p: [0, 0, 20, 0, 20, 10, 0, 10], z: [3, 3, 3, 3], e: [1, 2, 2, 2] }] }),
    ]);
    const pos = sink.build().getAttribute('position');
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) minY = Math.min(minY, pos.getY(i));
    expect(minY).toBeCloseTo(DECK_BASE_Y + 3 - DECK_SLAB_M, 5);
  });
});
