import { describe, expect, it } from 'vitest';
import {
  canvasColor,
  canvasRgb,
  GROUND_COLORS,
  groundResolutionFor,
  KERB_WIDTH_M,
  kerbBand,
  paintGround,
  paintRailHeads,
  paintSeasonMask,
  RAIL_HEAD_WIDTH_M,
  roadColor,
  SEASON_CLASS,
  seasonMaskResolutionFor,
  type GroundContext2D,
} from '../../../src/city/ground/groundRaster';
import {
  bresenhamPolyline,
  hardenPaint,
  isPaintedRoad,
  PAINT_DASH,
  PAINT_SOLID,
  paintableRanges,
  slicePolyline,
  type PaintGrid,
} from '../../../src/city/ground/groundMarkings';
import { offsetPolyline, polylineLength } from '../../../src/city/ground/polyline';
import { buildTilePayload } from '../../../src/engine/tiles/tileBuild';
import type { GroundStroke, TileData } from '../../../src/shared/types';

/** Records every stroke() with its style so paint order can be asserted. */
class RecordingContext implements GroundContext2D {
  rects: Array<{ color: string; rect: [number, number, number, number] }> = [];
  fillColors: string[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  strokeStyle: string | CanvasGradient | CanvasPattern = '';
  lineWidth = 1;
  lineDashOffset = 0;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  strokes: Array<{ color: string; width: number; start: [number, number] }> = [];
  fills = 0;
  private start: [number, number] = [0, 0];
  setTransform(): void {}
  setLineDash(): void {}
  beginPath(): void {}
  moveTo(x: number, y: number): void {
    this.start = [x, y];
  }
  lineTo(): void {}
  closePath(): void {}
  fill(): void {
    this.fills++;
    this.fillColors.push(String(this.fillStyle));
  }
  stroke(): void {
    this.strokes.push({ color: String(this.strokeStyle), width: this.lineWidth, start: this.start });
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rects.push({ color: String(this.fillStyle), rect: [x, y, w, h] });
  }
}

function road(partial: Partial<GroundStroke>): GroundStroke {
  return { k: 'road', c: 'residential', w: 6.6, p: [0, 0, 100, 0], s0: 0, r: 8, ...partial };
}

function tile(strokes: GroundStroke[]): TileData {
  return {
    tileX: 0,
    tileY: 0,
    bounds: [0, 0, 512, 512],
    buildings: [],
    surfaces: [],
    roads: [],
    trees: [],
    ground: { version: 1, strokes },
  };
}

describe('polyline helpers', () => {
  it('offsets a straight line to the left of travel', () => {
    expect(offsetPolyline([0, 0, 10, 0], 2)).toEqual([0, 2, 10, 2]);
    expect(offsetPolyline([0, 0, 10, 0], -2)).toEqual([0, -2, 10, -2]);
  });

  it('keeps a constant distance through a right-angle bend (miter)', () => {
    const out = offsetPolyline([0, 0, 10, 0, 10, 10], 1);
    expect(out[2]).toBeCloseTo(9, 6);
    expect(out[3]).toBeCloseTo(1, 6);
  });

  it('measures and slices by arc length', () => {
    const flat = [0, 0, 10, 0, 10, 10];
    expect(polylineLength(flat)).toBeCloseTo(20, 6);
    expect(slicePolyline(flat, 5, 15)).toEqual([5, 0, 10, 0, 10, 5]);
  });
});

describe('junction trims', () => {
  it('cuts nj intervals (absolute arc length) out of the paintable range', () => {
    const ranges = paintableRanges({ p: [0, 0, 100, 0], s0: 0, nj: [40, 60] });
    expect(ranges).toEqual([
      [0, 40],
      [60, 100],
    ]);
  });

  it('interprets nj in the source-way frame of s0 (tile-clipped strokes)', () => {
    // The clipped stroke starts 236 m along its way; the junction sits at 250 m.
    const ranges = paintableRanges({ p: [0, 0, 100, 0], s0: 236, nj: [240, 260] });
    expect(ranges).toEqual([
      [0, 4],
      [24, 100],
    ]);
  });

  it('paints no lane lines on links, service aisles, stone and bridges', () => {
    expect(isPaintedRoad(road({}))).toBe(true);
    expect(isPaintedRoad(road({ ln: 1 }))).toBe(false);
    expect(isPaintedRoad(road({ c: 'service' }))).toBe(false);
    expect(isPaintedRoad(road({ mat: 'stone' }))).toBe(false);
    expect(isPaintedRoad(road({ b: 1 }))).toBe(false);
  });
});

describe('painter order', () => {
  it('paints sidewalks, then every kerb casing, then every fill in rank order', () => {
    const ctx = new RecordingContext();
    const primary = road({ c: 'primary', w: 12.6, r: 20, kb: 1, sw: [3, 3], p: [0, 0, 100, 0] });
    const side = road({ c: 'residential', w: 6.6, r: 8, kb: 1, p: [50, 0, 50, 100] });
    paintGround(ctx, tile([primary, side]), [0, 0, 512, 512], 0.5, 1024, 1024);
    const kerb = canvasColor(GROUND_COLORS.kerb);
    const sidewalk = canvasColor(GROUND_COLORS.sidewalk);
    const order = ctx.strokes.map((s) => s.color);
    const lastKerb = order.lastIndexOf(kerb);
    const firstFill = order.findIndex((c) => c === canvasColor(roadColor(side)) || c === canvasColor(roadColor(primary)));
    expect(order[0]).toBe(sidewalk);
    expect(ctx.strokes[0].width).toBeCloseTo(12.6 + 2 * (KERB_WIDTH_M + 3), 6);
    expect(lastKerb).toBeLessThan(firstFill);
    // Minor street first, the major street last so it owns the junction.
    const fills = ctx.strokes.slice(firstFill);
    expect(fills[0].start).toEqual([50, 0]);
    expect(fills[fills.length - 1].start).toEqual([0, 0]);
  });

  it('never paints bridge strokes into the ground', () => {
    const ctx = new RecordingContext();
    const stats = paintGround(ctx, tile([road({ b: 1 })]), [0, 0, 512, 512], 0.5, 1024, 1024);
    expect(stats.bridgeSkipped).toBe(1);
    expect(ctx.strokes).toHaveLength(0);
  });

  it('skips malformed strokes instead of throwing', () => {
    const ctx = new RecordingContext();
    const bad = [road({ p: [0, 0] }), road({ w: Number.NaN }), road({ p: [0, 0, Number.NaN, 1] })];
    expect(() => paintGround(ctx, tile(bad), [0, 0, 512, 512], 0.5, 1024, 1024)).not.toThrow();
    expect(ctx.strokes).toHaveLength(0);
  });
});

describe('rail appearance across ground LODs', () => {
  it.each([0.25, 0.5, 1, 2, 4])('keeps physical gauge, width and each family colour at %s m/texel', (res) => {
    const data = tile([
      road({ k: 'rail', w: 3.5, p: [16, 64, 240, 64] }),
      road({ k: 'tram', w: 2.2, p: [16, 128, 240, 128] }),
    ]);
    const ctx = new RecordingContext();
    paintRailHeads(ctx, data, data.bounds!, res);
    expect(ctx.strokes.map(s => s.width)).toEqual(Array(4).fill(RAIL_HEAD_WIDTH_M));
    expect(ctx.strokes.map(s => s.color)).toEqual([
      canvasColor(GROUND_COLORS.railHead), canvasColor(GROUND_COLORS.railHead),
      canvasColor(GROUND_COLORS.tramRail), canvasColor(GROUND_COLORS.tramRail),
    ]);
    expect(ctx.strokes.map(s => s.start[1])).toEqual([63.28, 64.72, 127.28, 128.72]);
  });

  it('omits bridges and invalid strokes, and defers heads without losing the ballast', () => {
    const data = tile([road({ k: 'rail', w: 3.5 }), road({ k: 'rail', b: 1 }),
      road({ k: 'tram', p: [0, 0] }), road({ k: 'rail', w: Number.NaN })]);
    const ctx = new RecordingContext();
    paintGround(ctx, data, [0, 0, 512, 512], 4, 128, 128, { railHeads: false });
    expect(ctx.strokes.map(s => s.color)).toEqual([
      canvasColor(GROUND_COLORS.railBallast), canvasColor(GROUND_COLORS.railTie),
    ]);
    paintRailHeads(ctx, data, [0, 0, 512, 512], 4);
    expect(ctx.strokes).toHaveLength(4);
  });
});

describe('payload 0.4.1 ground fills', () => {
  it('paints tram beds and reservations before kerbs, asphalt gaps after the fills', () => {
    const ctx = new RecordingContext();
    const data = tile([
      road({ kb: 1, p: [0, 0, 100, 0] }),
      { k: 'tram', c: 'unknown', w: 2.2, p: [0, 10, 100, 10], s0: 0, r: 0 },
    ]);
    data.ground!.fills = [
      { m: 'tram', p: [0, 5, 100, 5, 100, 8, 0, 8] },
      { m: 'asphalt', c: 'secondary', p: [0, 3, 100, 3, 100, 4, 0, 4] },
      { m: 'platform', p: [40, 12, 70, 12, 70, 14, 40, 14] },
    ];
    const stats = paintGround(ctx, data, [0, 0, 512, 512], 0.5, 1024, 1024);
    expect(stats.medians).toBe(2);
    expect(stats.platforms).toBe(1);
    const order = ctx.strokes.map((s) => s.color);
    const bed = canvasColor(GROUND_COLORS.tramBed);
    expect(order.indexOf(bed)).toBeLessThan(order.indexOf(canvasColor(GROUND_COLORS.kerb)));
    const asphalt = canvasColor(roadColor({ c: 'secondary' }));
    expect(ctx.fillColors).toContain(bed);
    expect(ctx.fillColors[ctx.fillColors.length - 1]).toBe(asphalt);
  });

  it('kerbs closing fills before the carriageways and fills them (with holes) after', () => {
    const ctx = new RecordingContext();
    const data = tile([road({ kb: 1, p: [0, 0, 100, 0] })]);
    data.ground!.fills = [
      {
        m: 'asphalt',
        c: 'primary',
        kb: 1,
        p: [10, 4, 30, 4, 20, 14],
        h: [[18, 6, 22, 6, 20, 9]],
      },
    ];
    paintGround(ctx, data, [0, 0, 512, 512], 0.5, 1024, 1024);
    const kerb = canvasColor(GROUND_COLORS.kerb);
    const fill = canvasColor(roadColor({ c: 'primary' }));
    // Road kerb + fill-outline kerb, both before the road fill stroke.
    const kerbs = ctx.strokes.filter((s) => s.color === kerb);
    expect(kerbs).toHaveLength(2);
    expect(ctx.strokes.findIndex((s) => s.color === fill)).toBeGreaterThan(ctx.strokes.lastIndexOf(kerbs[1]));
    expect(ctx.fillColors[ctx.fillColors.length - 1]).toBe(fill);
  });

  it('widens asphalt, kerb and pavement by the on-street parking strips', () => {
    const band = kerbBand({ p: [0, 0, 100, 0], w: 4, pk: [4.6, 2.3] });
    expect(band.w).toBeCloseTo(4 + 4.6 + 2.3, 6);
    // Shifted towards the wider (left = +y) parking side.
    expect(band.p[1]).toBeCloseTo((4.6 - 2.3) / 2, 6);
    expect(kerbBand({ p: [0, 0, 100, 0], w: 4 })).toEqual({ p: [0, 0, 100, 0], w: 4 });
    const ctx = new RecordingContext();
    paintGround(ctx, tile([road({ w: 4, kb: 1, pk: [4.6, 4.6], po: [2, 2] })]), [0, 0, 512, 512], 0.5, 1024, 1024);
    const kerb = ctx.strokes.find((s) => s.color === canvasColor(GROUND_COLORS.kerb));
    expect(kerb?.width).toBeCloseTo(4 + 9.2 + 2 * KERB_WIDTH_M, 6);
  });

  it('uses one asphalt tone for every carriageway class except service / living streets', () => {
    expect(roadColor({ c: 'secondary' })).toBe(roadColor({ c: 'primary' }));
    expect(roadColor({ c: 'residential' })).toBe(roadColor({ c: 'trunk' }));
    expect(roadColor({ c: 'service' })).not.toBe(roadColor({ c: 'primary' }));
  });

  it('repaints the base outside the data extent', () => {
    const ctx = new RecordingContext();
    const data = tile([road({})]);
    data.ground!.clip = [-800, -800, 400, 800];
    paintGround(ctx, data, [0, 0, 512, 512], 0.5, 1024, 1024);
    const outside = ctx.rects.filter((r) => r.rect[0] >= 400);
    expect(outside).toHaveLength(1);
  });
});

describe('1-texel paint', () => {
  const grid = (x0: number): PaintGrid => ({ width: 16, height: 4, x0, y1: 2, res: 1 });

  it('rasterises a solid horizontal line one texel thick', () => {
    const data = new Uint8ClampedArray(16 * 4 * 4);
    const written = bresenhamPolyline(data, grid(0), [0.5, 0.5, 15.5, 0.5], PAINT_SOLID, null, 0);
    expect(written).toBe(16);
    for (let x = 0; x < 16; x++) expect(data[(1 * 16 + x) * 4 + 3]).toBe(255);
  });

  it('keeps the dash phase continuous across neighbouring tiles', () => {
    // One 32 m line split at x = 16 m, painted by two 16-texel tiles: the dash
    // pattern of the second tile continues the first because the phase is the
    // arc length along the source way (s0), not the tile-local distance.
    const line = [0.5, 0.5, 31.5, 0.5];
    const whole = new Uint8ClampedArray(32 * 4 * 4);
    bresenhamPolyline(whole, { width: 32, height: 4, x0: 0, y1: 2, res: 1 }, line, PAINT_DASH, [2, 4], 0);
    const east = new Uint8ClampedArray(16 * 4 * 4);
    bresenhamPolyline(east, grid(16), [16.5, 0.5, 31.5, 0.5], PAINT_DASH, [2, 4], 16);
    for (let x = 0; x < 16; x++) {
      expect(east[(16 + x) * 4 + 3]).toBe(whole[(32 + 16 + x) * 4 + 3]);
    }
  });

  it('hardens partial coverage into opaque solid/dim paint', () => {
    const data = new Uint8ClampedArray([255, 255, 255, 200, 128, 128, 128, 255, 9, 9, 9, 50]);
    expect(hardenPaint(data, [1, 2, 3], [4, 5, 6])).toBe(2);
    expect(Array.from(data)).toEqual([1, 2, 3, 255, 4, 5, 6, 255, 9, 9, 9, 0]);
  });
});

describe('colour and resolution', () => {
  it('linearises palette hex once (matching the double-linear vertex path)', () => {
    expect(canvasRgb('#ffffff')).toEqual([255, 255, 255]);
    expect(canvasRgb('#000000')).toEqual([0, 0, 0]);
    // sRGB 0.5 → linear ≈ 0.214
    expect(canvasRgb('#808080')[0]).toBe(55);
  });

  it('caps the ground texture at 1024 texels per tile side by default', () => {
    expect(groundResolutionFor(512)).toBe(0.5);
    expect(groundResolutionFor(1024)).toBe(1);
    expect(groundResolutionFor(512, 0.25)).toBe(0.25);
  });
});

describe('season mask', () => {
  it('anchors the mask at two ground texels and never below 0.5 m', () => {
    expect(seasonMaskResolutionFor(0.25)).toBe(0.5);
    expect(seasonMaskResolutionFor(0.5)).toBe(1);
    expect(seasonMaskResolutionFor(1)).toBe(2);
    expect(seasonMaskResolutionFor(4)).toBe(8);
    expect(seasonMaskResolutionFor(Number.NaN)).toBe(2);
  });

  it('keeps the channel contract (asphalt 0, paving 64, grass 128, water 192)', () => {
    expect(SEASON_CLASS).toEqual({ asphalt: 0, paving: 64, grass: 128, water: 192, other: 255 });
  });

  it('returns null without OffscreenCanvas, so the tile build stays safe', () => {
    const data = tile([]);
    data.surfaces = [{ kind: 'grass', polygon: [[[0, 0], [50, 0], [50, 50], [0, 50]]] }];
    expect(paintSeasonMask(data, [0, 0, 512, 512], 1)).toBeNull();
  });
});

describe('tile build integration', () => {
  it('falls back to the vector ground when OffscreenCanvas is unavailable', () => {
    const data = tile([road({})]);
    data.surfaces = [{ kind: 'grass', polygon: [[[0, 0], [50, 0], [50, 50], [0, 50]]] }];
    const payload = buildTilePayload(data, { facadeDetail: false, trees: false });
    expect(payload.ground ?? null).toBeNull();
    expect(payload.season ?? null).toBeNull();
    expect(payload.environment?.triangleCount ?? 0).toBeGreaterThan(0);
  });
});
