/**
 * Street lamp spots for the night layer.
 *
 * Sampled from the raster ground strokes inside the tile worker: a lamp point
 * every `LAMP_SPACING_M` of arc along major carriageways, alternating between
 * the two roadsides. Positions are phase-locked to the absolute way arc
 * (`stroke.s0`), so neighbouring tiles — which carry overlapping 64 m margin
 * copies of the same stroke — agree on the lamp grid; ownership is made unique
 * with half-open tile bounds, so every lamp is emitted by exactly one tile.
 *
 * Pure math, no THREE: runs in the worker and in unit tests.
 */

import type { RoadClass } from '../../shared/types';
import type { TileData } from '../../shared/types';

/** Lamp spacing along a carriageway, metres (arc length). */
export const LAMP_SPACING_M = 46;
/** How far the lamp stands from the centreline (roadside), metres. */
export const LAMP_ROADSIDE_OFFSET_M = 1.7;
/** Road classes that get lamps. Residential streets stay dark for now: the
 * instance budget is spent where lamps read best (district zoom). */
const LAMP_ROAD_CLASSES: ReadonlySet<RoadClass> = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
]);

/**
 * Lamp spots for one tile: flat [x, z, ...] in world metres (x east, z south).
 * Returns null when the tile has no eligible road strokes.
 */
export function collectLampSpots(data: TileData): Float32Array | null {
  const strokes = data.ground?.strokes;
  if (!strokes || strokes.length === 0) return null;
  const [minX, minY, maxX, maxY] = data.bounds;
  const spots: number[] = [];

  for (const stroke of strokes) {
    if (stroke.k !== 'road' || stroke.b === 1) continue;
    if (!LAMP_ROAD_CLASSES.has(stroke.c)) continue;
    const p = stroke.p;
    // The centreline offset is clamped so wide dual carriageways keep lamps
    // near the kerb instead of throwing them into the opposite carriageway.
    const offset = Math.min(stroke.w * 0.5 + LAMP_ROADSIDE_OFFSET_M, 9);
    let localArc = 0;

    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const ay = p[i + 1];
      const bx = p[i + 2];
      const by = p[i + 3];
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      if (length < 1e-3) continue;
      const nx = -dy / length;
      const ny = dx / length;

      // First lamp of this segment: the next multiple of SPACING on the
      // absolute way arc (stroke.s0 phases the grid across tile borders).
      const absoluteStart = stroke.s0 + localArc;
      let t = LAMP_SPACING_M - ((absoluteStart % LAMP_SPACING_M) + LAMP_SPACING_M) % LAMP_SPACING_M;
      for (; t <= length; t += LAMP_SPACING_M) {
        const absoluteArc = absoluteStart + t;
        // Alternate roadsides; parity of the absolute arc keeps neighbouring
        // tiles (which re-emit the margin band) on the same side.
        const side = Math.floor(absoluteArc / LAMP_SPACING_M) % 2 === 0 ? 1 : -1;
        const x = ax + (dx / length) * t + nx * offset * side;
        const y = ay + (dy / length) * t + ny * offset * side;
        // Half-open tile bounds: unique ownership across the tile grid.
        if (x < minX || x >= maxX || y < minY || y >= maxY) continue;
        spots.push(x, -y);
      }
      localArc += length;
    }
  }

  if (spots.length === 0) return null;
  return new Float32Array(spots);
}
