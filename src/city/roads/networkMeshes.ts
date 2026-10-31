/**
 * Semantic road markings for payload 0.2.0: dashed centre lines, zebras and
 * stop lines derived from the normalized road network layer.
 *
 * Markings are no longer guessed from buffered surface polygons: the pipeline
 * gives real centrelines (`RoadNetworkPiece.centerline`, already overhanging the
 * tile by ~4 m), junction boxes and pedestrian crossings. This module turns
 * them into flat quads just above `ENV_LAYER_Y.markings` (see the paint-height
 * constants below for why crossings are a few millimetres above the dashes):
 *
 *  - **dashed centre line** — one dash per `spacing` metres, 3.0 m long and
 *    0.5 m wide, only on asphalt motorway/trunk/primary/secondary carriageways
 *    at least 7 m wide. The phase is anchored to the arc length along the
 *    source OSM way (`centerlineOffset + station`), so the dash rhythm is
 *    continuous across tiles. A dash is *owned* by the tile whose bounds contain
 *    its centre (half-open bounds), which is what prevents two neighbouring
 *    tiles from painting the same straddling dash twice now that the centreline
 *    overhangs into both.
 *  - **zebra bars** — bars run along the road direction, one per metre across
 *    the carriageway, 0.5 m thick, spanning `span` along the road.
 *  - **stop lines** — 0.5 m thick band across the carriageway, before the
 *    crossing on each approach (one approach on a one-way street).
 *
 * Junction boxes suppress lane paint (`radius + dashLen/2 + 0.5 m` clearance),
 * crossings on this road suppress it around the crossing centre by
 * `max(2.5, span/2 + 1) + dashLen/2` (the extra half dash keeps the dash *body*
 * out of the stop line/zebra paint, not just its centre), and every dash corner
 * inside the tile must lie in a drivable *asphalt* piece — so paint never spills
 * onto paving, stone or concrete. Corners that overhang into the neighbouring
 * tile are not tested (their asphalt lives there), which keeps the centre-line
 * rhythm continuous across tile borders while the centre-in-bounds ownership
 * rule still makes exactly one tile paint each dash.
 *
 * Hard per-tile budgets keep dense tiles cheap: 900 triangles of lane paint
 * (dashes + stop lines) and 600 triangles of zebra bars, truncated
 * deterministically in payload order.
 */

import type {
  CrossingFeature,
  JunctionFeature,
  RoadClass,
  RoadMaterial,
  RoadNetworkPiece,
  TileData,
} from '../../shared/types';
import { MARKING_COLOR, MARKING_COLOR_DIM } from '../../engine/materials/palette';
import { ringBounds } from '../../shared/tileMath';
import {
  DASH_MARKING_CLASSES,
  ENV_LAYER_Y,
  LAYER_JITTER_STEP_M,
  type Bounds4,
} from '../environment/envLayers';
import type { GeometrySink } from '../environment/meshBuilder';
import { prepareFlatPolygon, type PreparedPolygon } from '../environment/triangulate';
import { pointInPreparedPolygon, type Point2 } from './roadAnalysis';
import { centerlinePoints, pathLength, stationAt, type PathStation } from './roadPath';

/** Lane-marking dash geometry, metres. */
export const DASH_LENGTH_M = 3.0;
export const DASH_WIDTH_M = 0.5;
/** Dashes only on carriageways at least this wide, metres. */
export const DASH_MIN_ROAD_WIDTH_M = 7;
/** Junction clearance beyond `radius + dashLen/2`, metres. */
const JUNCTION_CLEARANCE_M = 0.5;
/** Minimum dash clearance around a crossing of the same road, metres. */
const CROSSING_CLEARANCE_MIN_M = 2.5;
/** Clearance beyond the crossing half-span, metres. */
const CROSSING_CLEARANCE_PAD_M = 1.0;
/** A crossing belongs to this road when its angle differs by <= 30°. */
const CROSSING_ROAD_ANGLE_RAD = (30 * Math.PI) / 180;
/** Corners closer than this to the tile border are tested against the tile. */
const CORNER_TILE_MARGIN_M = 0.01;

/** Dash spacing per road class, metres (rhythm of the source avenue). */
const DASH_SPACING_M: Partial<Record<RoadClass, number>> = {
  motorway: 8,
  trunk: 8,
  primary: 8,
  secondary: 9,
};

/** Zebra bar layout, metres. */
const ZEBRA_BAR_WIDTH_M = 0.5;
const ZEBRA_STEP_M = 1.0;
/** Inset from the carriageway edge to the first zebra bar, metres. */
const ZEBRA_EDGE_INSET_M = 0.55;
/** Stop line thickness along the road, metres. */
const STOP_LINE_WIDTH_M = 0.5;
/** Gap between crossing edge and stop line, metres. */
const STOP_LINE_GAP_M = 0.7;
const DEFAULT_CROSSING_SPAN_M = 4;

/** Paint budgets per tile, triangles. */
export const MAX_MARKING_TRIANGLES_PER_TILE = 900;
export const MAX_ZEBRA_TRIANGLES_PER_TILE = 600;

/**
 * Paint heights.
 *
 * Lane dashes sit exactly at `ENV_LAYER_Y.markings`. A crossing (zebra bars or
 * stop lines) can geometrically overlap the centre line — mid-block crossings
 * and stop lines that cross it — so the two paint families must not be coplanar
 * or they z-fight. Crossings therefore use the next sub-level of the markings
 * layer (the same 1.5 mm step the layer jitter uses, which is >2× the depth
 * resolution of the isometric camera). The markings band is preserved, so this
 * still respects the "every flat surface sits in exactly one layer band"
 * invariant; crossings do not overlap each other in the pilot payload.
 */
export const CROSSING_PAINT_Y = ENV_LAYER_Y.markings + LAYER_JITTER_STEP_M;


/** Safety cap so a pathological centreline cannot spin forever. */
const MAX_DASH_CENTRES_PER_PIECE = 4096;

/** Crossings are painted only on these surfaces. */
const PAINTED_CROSSING_MATERIALS: ReadonlySet<RoadMaterial> = new Set<RoadMaterial>([
  'asphalt',
  'stone',
]);

/** Tile slice needed by the network pass. */
export type RoadNetworkSource = Pick<
  TileData,
  'roadSurfaces' | 'roadNetwork' | 'junctions' | 'crossings'
>;

/** Counters for the road network marking pass. */
export interface RoadNetworkStats {
  /** Network pieces inspected for lane paint. */
  pieces: number;
  /** Network pieces that produced at least one dash. */
  dashedPieces: number;
  /** Dashes emitted. */
  dashes: number;
  /** Dashes rejected because their centre is outside the tile. */
  boundsSkipped: number;
  /** Dashes rejected by a junction clearance circle. */
  junctionSkipped: number;
  /** Dashes rejected around a pedestrian crossing of the same road. */
  crossingClearanceSkipped: number;
  /** Dashes rejected because a corner left the drivable asphalt pieces. */
  containmentSkipped: number;
  /** Malformed network records. */
  skippedPieces: number;
  /** Painted crossings (zebra / signals) processed. */
  crossings: number;
  /** Crossings rejected because of missing/invalid data or material. */
  crossingsSkipped: number;
  zebraBars: number;
  stopLines: number;
  /** Triangles of lane paint (dashes + stop lines). */
  markingTriangles: number;
  /** Triangles of zebra bars. */
  zebraTriangles: number;
  /** True when a per-tile budget truncated the output. */
  capped: boolean;
}

export function createRoadNetworkStats(): RoadNetworkStats {
  return {
    pieces: 0,
    dashedPieces: 0,
    dashes: 0,
    boundsSkipped: 0,
    junctionSkipped: 0,
    crossingClearanceSkipped: 0,
    containmentSkipped: 0,
    skippedPieces: 0,
    crossings: 0,
    crossingsSkipped: 0,
    zebraBars: 0,
    stopLines: 0,
    markingTriangles: 0,
    zebraTriangles: 0,
    capped: false,
  };
}

/** A drivable asphalt piece prepared once per tile for containment tests. */
interface AsphaltPiece {
  prepared: PreparedPolygon;
  bbox: Bounds4;
}

/**
 * Emit lane paint and crossings for one tile into the shared roads sink.
 * Never throws: malformed records are counted and skipped.
 */
export function emitRoadNetwork(
  sink: GeometrySink,
  tile: RoadNetworkSource | null | undefined,
  bounds: Bounds4,
  stats: RoadNetworkStats,
): void {
  if (!tile) return;

  const asphalt = prepareAsphaltPieces(tile.roadSurfaces);
  const junctions = validJunctions(tile.junctions);
  const crossingClearances = prepareCrossingClearances(tile.crossings);
  const network = Array.isArray(tile.roadNetwork) ? tile.roadNetwork : [];
  for (let index = 0; index < network.length; index++) {
    const piece = network[index];
    stats.pieces++;
    if (!piece || typeof piece !== 'object' || !Array.isArray(piece.centerline)) {
      stats.skippedPieces++;
      continue;
    }
    try {
      emitDashesForPiece(sink, piece, bounds, junctions, crossingClearances, asphalt, stats);
    } catch {
      stats.skippedPieces++;
    }
  }

  const crossings = Array.isArray(tile.crossings) ? tile.crossings : [];
  for (let index = 0; index < crossings.length; index++) {
    try {
      emitCrossing(sink, crossings[index], stats);
    } catch {
      stats.crossingsSkipped++;
    }
  }
}

/** Prepare the tile's ground-level drivable asphalt pieces once. */
function prepareAsphaltPieces(
  pieces: TileData['roadSurfaces'] | null | undefined,
): AsphaltPiece[] {
  const out: AsphaltPiece[] = [];
  if (!Array.isArray(pieces)) return out;
  for (const piece of pieces) {
    if (!piece || piece.kind !== 'drivable' || piece.bridge === true) continue;
    if ((piece.material ?? 'asphalt') !== 'asphalt') continue;
    try {
      const prepared = prepareFlatPolygon(piece.polygon, { minArea: 0.01 });
      if (!prepared) continue;
      out.push({ prepared, bbox: ringBounds(prepared.exterior) });
    } catch {
      // Ignore: a broken surface simply provides no containment.
    }
  }
  return out;
}

function validJunctions(
  junctions: JunctionFeature[] | null | undefined,
): JunctionFeature[] {
  if (!Array.isArray(junctions)) return [];
  const out: JunctionFeature[] = [];
  for (const junction of junctions) {
    if (!junction) continue;
    if (!Number.isFinite(junction.x) || !Number.isFinite(junction.y)) continue;
    if (!Number.isFinite(junction.radius) || junction.radius < 0) continue;
    out.push(junction);
  }
  return out;
}

/** A crossing of this road, with the radius lane paint must keep clear of. */
interface CrossingClearance {
  x: number;
  y: number;
  /** Road direction at the crossing, radians. */
  angle: number;
  radius: number;
}

/**
 * Precompute crossing clearance circles for dash suppression. Any crossing
 * record with a finite position and angle participates; the centre clearance is
 * `max(2.5, span/2 + 1) + dashLen/2` metres so the dash body cannot touch the
 * crossing paint either.
 */
function prepareCrossingClearances(
  crossings: CrossingFeature[] | null | undefined,
): CrossingClearance[] {
  if (!Array.isArray(crossings)) return [];
  const out: CrossingClearance[] = [];
  for (const crossing of crossings) {
    if (!crossing) continue;
    if (
      !Number.isFinite(crossing.x) ||
      !Number.isFinite(crossing.y) ||
      !Number.isFinite(crossing.angle)
    ) {
      continue;
    }
    const span =
      Number.isFinite(crossing.span) && crossing.span > 0
        ? crossing.span
        : DEFAULT_CROSSING_SPAN_M;
    // The requested clearance is measured from the dash CENTRE; a 3 m dash
    // centred just outside that radius would still physically cross the stop
    // line (which lies ~0.25 m inside `span/2 + 1`), so half a dash is added
    // on top: the dash body, not just its centre, stays out of the crossing.
    const radius =
      Math.max(CROSSING_CLEARANCE_MIN_M, span / 2 + CROSSING_CLEARANCE_PAD_M) +
      DASH_LENGTH_M / 2;
    out.push({ x: crossing.x, y: crossing.y, angle: crossing.angle, radius });
  }
  return out;
}

/**
 * Dash centre arc-length stations for one piece.
 *
 * The global phase `(centerlineOffset + s) mod spacing` is in the dash window
 * `[0, dashLength)` exactly at these centres, with the dash occupying the first
 * 3 m of each period. Centres inside `[0, total]` are generated (including the
 * one whose dash started just before the piece and whose centre still lies on
 * it); the bounds-ownership rule then decides which tile paints each dash.
 */
function dashCentreStations(total: number, offset: number, spacing: number): number[] {
  const stations: number[] = [];
  if (!(spacing > 0) || !(total > 0) || !Number.isFinite(total)) return stations;
  const phase = Number.isFinite(offset) ? offset : 0;
  const half = DASH_LENGTH_M / 2;
  const firstK = Math.ceil((phase - half) / spacing);
  const lastK = Math.floor((total + phase - half) / spacing);
  for (let k = firstK; k <= lastK; k++) {
    if (stations.length >= MAX_DASH_CENTRES_PER_PIECE) break;
    const s = k * spacing + half - phase;
    if (!Number.isFinite(s)) continue;
    // Numeric tolerance at the piece ends; the phase error introduced by the
    // clamp is < 1e-9 m and cannot be seen.
    if (s < -1e-9 || s > total + 1e-9) continue;
    stations.push(s < 0 ? 0 : s > total ? total : s);
  }
  return stations;
}

function emitDashesForPiece(
  sink: GeometrySink,
  piece: RoadNetworkPiece,
  bounds: Bounds4,
  junctions: readonly JunctionFeature[],
  crossings: readonly CrossingClearance[],
  asphalt: readonly AsphaltPiece[],
  stats: RoadNetworkStats,
): void {
  if (piece.kind !== 'road') return;
  if (piece.material !== 'asphalt') return;
  if (piece.bridge === true) return;
  if (!DASH_MARKING_CLASSES.has(piece.class)) return;
  if (!Number.isFinite(piece.width) || piece.width < DASH_MIN_ROAD_WIDTH_M) return;
  const spacing = DASH_SPACING_M[piece.class] ?? 0;
  if (!(spacing > 0)) return;

  const points = centerlinePoints(piece.centerline);
  if (points.length < 2) {
    stats.skippedPieces++;
    return;
  }
  const total = pathLength(points);
  if (!(total >= DASH_LENGTH_M)) return;
  const offset = Number.isFinite(piece.centerlineOffset) ? piece.centerlineOffset : 0;

  const centres = dashCentreStations(total, offset, spacing);
  let emitted = 0;
  for (const s of centres) {
    if (stats.markingTriangles + 2 > MAX_MARKING_TRIANGLES_PER_TILE) {
      stats.capped = true;
      break;
    }
    const station = stationAt(points, s);
    if (!station) continue;
    // Ownership rule: the tile containing the dash centre paints it. Bounds are
    // half-open so a centre exactly on a shared border belongs to exactly one
    // tile; the 4 m centreline overhang guarantees that tile sees the dash.
    if (!insideBounds(station.x, station.y, bounds)) {
      stats.boundsSkipped++;
      continue;
    }
    if (insideJunctionClearance(station.x, station.y, junctions)) {
      stats.junctionSkipped++;
      continue;
    }
    if (insideCrossingClearance(station, crossings)) {
      stats.crossingClearanceSkipped++;
      continue;
    }
    const corners = dashCorners(station);
    if (!insideAnyAsphalt(corners, asphalt, bounds)) {
      stats.containmentSkipped++;
      continue;
    }
    if (
      sink.addFlatQuad(
        corners[0],
        corners[1],
        corners[2],
        corners[3],
        ENV_LAYER_Y.markings,
        MARKING_COLOR,
      )
    ) {
      stats.dashes++;
      stats.markingTriangles += 2;
      emitted++;
    }
  }
  if (emitted > 0) stats.dashedPieces++;
}

function dashCorners(station: PathStation): [Point2, Point2, Point2, Point2] {
  // Normal of the tangent: n = (-uy, ux), positive = left of travel.
  return quadCorners(
    station.x,
    station.y,
    station.ux,
    station.uy,
    -station.uy,
    station.ux,
    DASH_LENGTH_M / 2,
    DASH_WIDTH_M / 2,
  );
}

/** Four corners of a rectangle centred at (x, y), aligned to axes (ux) / (nx). */
function quadCorners(
  x: number,
  y: number,
  ux: number,
  uy: number,
  nx: number,
  ny: number,
  halfAlong: number,
  halfAcross: number,
): [Point2, Point2, Point2, Point2] {
  const ax = x - ux * halfAlong;
  const ay = y - uy * halfAlong;
  const bx = x + ux * halfAlong;
  const by = y + uy * halfAlong;
  return [
    [ax - nx * halfAcross, ay - ny * halfAcross],
    [bx - nx * halfAcross, by - ny * halfAcross],
    [bx + nx * halfAcross, by + ny * halfAcross],
    [ax + nx * halfAcross, ay + ny * halfAcross],
  ];
}

function insideBounds(x: number, y: number, bounds: Bounds4): boolean {
  return x >= bounds[0] && x < bounds[2] && y >= bounds[1] && y < bounds[3];
}

function insideJunctionClearance(
  x: number,
  y: number,
  junctions: readonly JunctionFeature[],
): boolean {
  const clearance = DASH_LENGTH_M / 2 + JUNCTION_CLEARANCE_M;
  for (const junction of junctions) {
    const dx = x - junction.x;
    const dy = y - junction.y;
    if (dx * dx + dy * dy < (junction.radius + clearance) * (junction.radius + clearance)) {
      return true;
    }
  }
  return false;
}

/** Dashes keep clear of a crossing of this road (same direction, +/-30°). */
function insideCrossingClearance(
  station: PathStation,
  crossings: readonly CrossingClearance[],
): boolean {
  if (crossings.length === 0) return false;
  const tangent = Math.atan2(station.uy, station.ux);
  for (const crossing of crossings) {
    // Crossings are direction-less: compare modulo 180°.
    let delta = (crossing.angle - tangent) % Math.PI;
    if (delta < 0) delta += Math.PI;
    if (delta > Math.PI - delta) delta = Math.PI - delta;
    if (delta > CROSSING_ROAD_ANGLE_RAD) continue;
    const dx = station.x - crossing.x;
    const dy = station.y - crossing.y;
    if (dx * dx + dy * dy <= crossing.radius * crossing.radius) return true;
  }
  return false;
}

/**
 * Every dash corner that belongs to this tile must lie inside one drivable
 * asphalt piece. Corners overhanging into the neighbouring tile are ignored:
 * their asphalt lives there, and testing them against this tile's clipped
 * surface would drop every dash that straddles a tile border (a visible gap in
 * the centre-line rhythm). Ownership of the dash itself is still decided by its
 * centre (`insideBounds`).
 */
function insideAnyAsphalt(
  corners: readonly Point2[],
  asphalt: readonly AsphaltPiece[],
  bounds: Bounds4,
): boolean {
  for (const piece of asphalt) {
    let allInside = true;
    for (const [x, y] of corners) {
      if (!cornerBelongsToTile(x, y, bounds)) continue;
      const [minX, minY, maxX, maxY] = piece.bbox;
      if (x < minX - 1e-6 || x > maxX + 1e-6 || y < minY - 1e-6 || y > maxY + 1e-6) {
        allInside = false;
        break;
      }
      if (!pointInPreparedPolygon(piece.prepared, x, y)) {
        allInside = false;
        break;
      }
    }
    if (allInside) return true;
  }
  return false;
}

/** True when a dash corner lies inside this tile (small margin for rounding). */
function cornerBelongsToTile(x: number, y: number, bounds: Bounds4): boolean {
  return (
    x >= bounds[0] - CORNER_TILE_MARGIN_M &&
    x <= bounds[2] + CORNER_TILE_MARGIN_M &&
    y >= bounds[1] - CORNER_TILE_MARGIN_M &&
    y <= bounds[3] + CORNER_TILE_MARGIN_M
  );
}

function emitCrossing(
  sink: GeometrySink,
  crossing: CrossingFeature | null | undefined,
  stats: RoadNetworkStats,
): void {
  if (!crossing || typeof crossing !== 'object') {
    stats.crossingsSkipped++;
    return;
  }
  if (crossing.kind === 'unmarked') return; // deliberately bare
  if (crossing.kind !== 'zebra' && crossing.kind !== 'signals') {
    stats.crossingsSkipped++;
    return;
  }
  if (!crossing.material || !PAINTED_CROSSING_MATERIALS.has(crossing.material)) {
    stats.crossingsSkipped++;
    return;
  }
  if (
    !Number.isFinite(crossing.x) ||
    !Number.isFinite(crossing.y) ||
    !Number.isFinite(crossing.angle)
  ) {
    stats.crossingsSkipped++;
    return;
  }
  const width = Number.isFinite(crossing.width) ? crossing.width : 0;
  if (!(width > 1)) {
    stats.crossingsSkipped++;
    return;
  }
  const span =
    Number.isFinite(crossing.span) && crossing.span > 0
      ? crossing.span
      : DEFAULT_CROSSING_SPAN_M;
  const ux = Math.cos(crossing.angle);
  const uy = Math.sin(crossing.angle);
  const nx = -uy;
  const ny = ux;
  stats.crossings++;

  if (crossing.kind === 'zebra') {
    emitZebraBars(sink, crossing.x, crossing.y, ux, uy, nx, ny, width, span, stats);
  }
  if (crossing.kind === 'zebra' || crossing.kind === 'signals') {
    emitStopLines(sink, crossing, ux, uy, nx, ny, width, span, stats);
  }
}

/** Zebra bars parallel to the road direction, one per metre across. */
function emitZebraBars(
  sink: GeometrySink,
  x: number,
  y: number,
  ux: number,
  uy: number,
  nx: number,
  ny: number,
  width: number,
  span: number,
  stats: RoadNetworkStats,
): void {
  const usableHalf = width / 2 - ZEBRA_EDGE_INSET_M;
  if (!(usableHalf > ZEBRA_BAR_WIDTH_M / 2)) return;
  const count = Math.max(
    0,
    Math.floor((usableHalf * 2 - ZEBRA_BAR_WIDTH_M) / ZEBRA_STEP_M) + 1,
  );
  if (count <= 0) return;
  const first = -((count - 1) * ZEBRA_STEP_M) / 2;
  for (let index = 0; index < count; index++) {
    if (stats.zebraTriangles + 2 > MAX_ZEBRA_TRIANGLES_PER_TILE) {
      stats.capped = true;
      break;
    }
    const lateral = first + index * ZEBRA_STEP_M;
    const cx = x + nx * lateral;
    const cy = y + ny * lateral;
    const corners = quadCorners(cx, cy, ux, uy, nx, ny, span / 2, ZEBRA_BAR_WIDTH_M / 2);
    if (
      sink.addFlatQuad(
        corners[0],
        corners[1],
        corners[2],
        corners[3],
        CROSSING_PAINT_Y,
        MARKING_COLOR,
      )
    ) {
      stats.zebraBars++;
      stats.zebraTriangles += 2;
    }
  }
}

/**
 * Stop line(s) across the carriageway, `span/2 + 0.7 m` before the crossing.
 * Both approaches unless the street is one-way (then the +u approach only).
 */
function emitStopLines(
  sink: GeometrySink,
  crossing: CrossingFeature,
  ux: number,
  uy: number,
  nx: number,
  ny: number,
  width: number,
  span: number,
  stats: RoadNetworkStats,
): void {
  const along = span / 2 + STOP_LINE_GAP_M;
  // +u is the travel direction: its stop line sits before the crossing (-u
  // side) and the opposite approach's line sits on the +u side. A one-way
  // street only has the +u approach, so it gets the -u line.
  const approaches = crossing.oneway === true ? ([-1] as const) : ([1, -1] as const);
  for (const direction of approaches) {
    if (stats.markingTriangles + 2 > MAX_MARKING_TRIANGLES_PER_TILE) {
      stats.capped = true;
      break;
    }
    const cx = crossing.x + ux * along * direction;
    const cy = crossing.y + uy * along * direction;
    // Long axis across the carriageway, 0.5 m thick along the road.
    const corners = quadCorners(cx, cy, nx, ny, -ny, nx, width / 2, STOP_LINE_WIDTH_M / 2);
    if (
      sink.addFlatQuad(
        corners[0],
        corners[1],
        corners[2],
        corners[3],
        CROSSING_PAINT_Y,
        MARKING_COLOR_DIM,
      )
    ) {
      stats.stopLines++;
      stats.markingTriangles += 2;
    }
  }
}
