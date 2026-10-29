/**
 * Parking stall markings for `amenity=parking` surfaces.
 *
 * The pipeline gives us only the parking polygon. Stall bays are derived from
 * the polygon's minimum-area rectangle (see `src/city/roads/roadAnalysis.ts`):
 * two rows of painted ticks run along the two long edges, perpendicular to the
 * long axis:
 *   - 5 m deep, inward from the edge,
 *   - 0.12 m tick width,
 *   - ~2.6 m stall spacing along the long axis,
 *   - ~1 m end margin so the end ticks do not touch the polygon corners.
 *
 * A tick is only painted when all four of its corners fall inside the prepared
 * polygon, so clipped / L-shaped / street-side bay outlines never grow marks
 * past their asphalt. The layout is derived purely from the geometry (no
 * randomness) and is hard-capped per polygon and per tile so one huge parking
 * apron cannot blow the marking triangle budget.
 *
 * The marks are emitted at the `markings` layer (same as road markings) so
 * they stay above the parking surface — and above the road, which is exactly
 * right for painted bays on the carriageway.
 */

import { shadeHex } from '../../engine/materials/palette';
import { layerY } from './envLayers';
import type { GeometrySink } from './meshBuilder';
import type { PreparedPolygon } from './triangulate';
import {
  crossSectionAt,
  minAreaRoadAxis,
  pointInPreparedPolygon,
  type Point2,
} from '../roads/roadAnalysis';

/** Stall depth measured inward from the long edge, metres. */
export const STALL_DEPTH_M = 5;
/** Painted tick width (along the long axis), metres.
 *
 * 0.22 m (not 0.12 m): at close zoom one screen pixel is ~6–10 cm, so a thinner
 * divider fragmented into 2–3 dots; 0.22 m keeps each stall line readable in
 * both pixel-art and clean modes. */
export const STALL_TICK_WIDTH_M = 0.22;
/** Stall spacing along the long axis, metres. */
export const STALL_SPACING_M = 2.6;
/** Margin left free at both ends of a row, metres. */
export const STALL_END_MARGIN_M = 1;
/** Start marks this far inside the edge so point-in-polygon is unambiguous. */
const STALL_EDGE_INSET_M = 0.12;

/** Parking polygons below this area get no stall marks, m². */
export const STALL_MIN_AREA_M2 = 180;
/** Parking polygons narrower than this (long axis short side) get no marks, m. */
export const STALL_MIN_SIDE_M = 10;

/** Hard caps: one tick is a quad, i.e. 2 triangles. */
export const MAX_PARKING_STALL_TRIANGLES_PER_POLYGON = 200;
export const MAX_PARKING_STALL_TRIANGLES_PER_TILE = 600;

/**
 * Painted stall-line tint: the same warm off-white as the road markings
 * (`shadeHex(SIDEWALK_COLOR, 0.55)` in roadMeshes.ts).
 */
const STALL_MARKING_COLOR = shadeHex('#a9a293', 0.55);

/** Stats slice owned by the parking stall emitter. */
export interface ParkingBuildStats {
  /** Parking polygons whose flat asphalt surface was emitted. */
  parkingPolygons: number;
  /** Painted stall ticks emitted. */
  parkingStalls: number;
  /** Triangles used by the stall ticks (2 per tick), capped. */
  parkingTriangles: number;
}

/** Point at station `t` along the long axis and offset `v` along the short axis. */
function framePoint(
  cx: number,
  cy: number,
  ux: number,
  uy: number,
  px: number,
  py: number,
  t: number,
  v: number,
): Point2 {
  return [cx + ux * t + px * v, cy + uy * t + py * v];
}

/**
 * Emit stall ticks for one prepared parking polygon. Never throws: bad or
 * missing geometry is skipped. Returns the number of triangles added.
 */
export function emitParkingStalls(
  sink: GeometrySink,
  prepared: PreparedPolygon | null | undefined,
  index: number,
  stats: ParkingBuildStats,
): number {
  if (!prepared || !Array.isArray(prepared.exterior) || prepared.exterior.length < 3) return 0;
  if (!(prepared.area >= STALL_MIN_AREA_M2)) return 0;
  if (stats.parkingTriangles >= MAX_PARKING_STALL_TRIANGLES_PER_TILE) return 0;

  const axis = minAreaRoadAxis(prepared.exterior);
  if (!axis) return 0;
  if (!(axis.width >= STALL_MIN_SIDE_M) || !(axis.length >= STALL_MIN_SIDE_M)) return 0;

  const ux = axis.ux;
  const uy = axis.uy;
  // Left normal of the long axis: the short-axis direction.
  const px = -uy;
  const py = ux;

  const halfLength = axis.length / 2;
  const firstT = -halfLength + STALL_END_MARGIN_M + STALL_TICK_WIDTH_M / 2;
  const lastT = halfLength - STALL_END_MARGIN_M - STALL_TICK_WIDTH_M / 2;
  if (!(lastT >= firstT)) return 0;

  const computedSlots = Math.floor((lastT - firstT) / STALL_SPACING_M + 1e-9) + 1;
  // Keep both rows within the per-polygon triangle cap (a tick is 2 triangles).
  const maxSlotsPerRow = Math.floor(MAX_PARKING_STALL_TRIANGLES_PER_POLYGON / 4);
  const slots = Math.min(computedSlots, maxSlotsPerRow);
  const halfTick = STALL_TICK_WIDTH_M / 2;
  const y = layerY('markings', index);
  const before = sink.triangleCount;

  for (const side of [-1, 1] as const) {
    for (let slot = 0; slot < slots; slot++) {
      if (stats.parkingTriangles >= MAX_PARKING_STALL_TRIANGLES_PER_TILE) {
        return sink.triangleCount - before;
      }
      const t = firstT + slot * STALL_SPACING_M;
      // Follow the REAL polygon edge at this station instead of the bounding
      // rectangle edge: parking aprons are often trapezoids, where a rectangle
      // row would fall outside the asphalt on one side.
      const section = crossSectionAt(prepared.exterior, axis, t);
      if (!section || section.halfWidth < 1.6) continue;
      // Narrow strip (a bay only ~8 m deep): a second facing row would leave an
      // undrivable aisle, so only the low side gets stalls there.
      if (side === 1 && section.halfWidth < 5) continue;
      const edgeOffset = section.mid + side * (section.halfWidth - STALL_EDGE_INSET_M);
      // Leave a 1.2 m aisle between the two rows on a normal lot; on a single
      // narrow row keep 1 m clearance to the opposite edge.
      const depth = Math.min(
        STALL_DEPTH_M,
        Math.max(
          1,
          side === 1 ? section.halfWidth - 0.6 : 2 * section.halfWidth - 1.0,
        ),
      );
      const innerOffset = edgeOffset - side * depth;
      const t0 = t - halfTick;
      const t1 = t + halfTick;
      const a = framePoint(axis.cx, axis.cy, ux, uy, px, py, t0, edgeOffset);
      const b = framePoint(axis.cx, axis.cy, ux, uy, px, py, t1, edgeOffset);
      const c = framePoint(axis.cx, axis.cy, ux, uy, px, py, t1, innerOffset);
      const d = framePoint(axis.cx, axis.cy, ux, uy, px, py, t0, innerOffset);
      // Both ends of the tick must sit on this polygon's asphalt: street-side
      // bays and tile-clipped outlines are often concave or truncated.
      if (!pointInPreparedPolygon(prepared, a[0], a[1])) continue;
      if (!pointInPreparedPolygon(prepared, b[0], b[1])) continue;
      if (!pointInPreparedPolygon(prepared, c[0], c[1])) continue;
      if (!pointInPreparedPolygon(prepared, d[0], d[1])) continue;
      if (sink.addFlatQuad(a, b, c, d, y, STALL_MARKING_COLOR)) {
        stats.parkingStalls++;
        stats.parkingTriangles += 2;
      }
    }
  }
  return sink.triangleCount - before;
}
