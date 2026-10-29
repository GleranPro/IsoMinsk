/**
 * Road / pavement / tram-rail meshes for one tile.
 *
 * The pipeline hands us buffered centreline polygons (already the correct
 * width) and, for drivable roads, the OSM centreline plus `lanes` / `oneway` /
 * `surface`. This module renders:
 *  - drivable polygons flat at the road layer with `ROAD_PALETTE` colours,
 *    tinted by the mapped `surface`;
 *  - real lane markings laid out along the centreline: dashed centre line,
 *    double solid centre on avenues, lane dividers, edge lines and painted
 *    cycle lanes (with the legacy rectangle-axis dashes as fallback for tiles
 *    that predate the centreline payload);
 *  - zebra bars, stop lines and signal heads for `TileData.crossings`;
 *  - raised lawn/stone medians on wide two-way avenues (broken at crossings
 *    and junctions);
 *  - footways / cycleways / paths at the sidewalk layer (cycleways painted red);
 *  - a subtle dark kerb strip around wider streets (0.6 m, its own layer just
 *    under the road so it can never z-fight the asphalt or the pavements);
 *  - rail/tram polygons as a dark ballast strip plus two light rail lines;
 *  - bridges as raised decks (BRIDGE_RAISE_M, no ramps) with a vertical skirt
 *    down to the ground, plus parapets, posts and piers when the centreline is
 *    available;
 *  - tunnels not at all.
 *
 * All flat and vertical road geometry is merged into the single `roads` sink of
 * the tile, so street furniture costs no extra draw calls.
 */

import type { CrossingFeature, Polygon, RoadClass, RoadPolygon } from '../../shared/types';
import { ROAD_PALETTE, ROAD_WIDTH_M, SIDEWALK_COLOR, mixHex } from '../../engine/materials/palette';
import { ringBounds } from '../../shared/tileMath';
import type { GeometrySink, Vec3 } from '../environment/meshBuilder';
import {
  BRIDGE_RAISE_M,
  DASH_MARKING_CLASSES,
  ENV_LAYER_Y,
  KERB_CLASSES,
  layerY,
  ringTouchesBounds,
  roadTier,
  type Bounds4,
} from '../environment/envLayers';
import {
  prepareFlatPolygon,
  signedRingArea,
  simplifyPreparedPolygon,
  simplifyRing,
  triangulatePrepared,
  type PreparedPolygon,
} from '../environment/triangulate';
import { offsetRingOutward, pointInPreparedPolygon, railLineLayout, roadDashes } from './roadAnalysis';
import { centerlinePoints, samplePath, type PathStation } from './roadPath';
import { laneMarkings } from './markingLayout';
import {
  addBar,
  createCrossingStats,
  emitCrossings,
  type CrossingStats,
  type RoadSurfaceRef,
} from './crossings';
import { createMedianStats, emitMedian, type MedianStats } from './medianMesh';
import { createBridgeStats, emitBridgeDetails, type BridgeStats } from './bridgeMesh';
import { BIKE_LANE_COLOR, MARKING_BAR_COLOR, cyclewayColor, roadSurfaceColor } from './roadColors';

const MIN_RING_AREA_M2 = 0.5;

/** Kerb strip width, metres. */
const KERB_WIDTH_M = 0.6;
/** Simplification tolerance used before offsetting a kerb outline, metres. */
const KERB_SIMPLIFY_TOLERANCE_M = 0.6;
/** Kerbs are skipped for tiny or very narrow polygons. */
const KERB_MIN_WIDTH_M = 6.5;
const KERB_MIN_AREA_M2 = 40;
const KERB_MAX_EDGES = 48;

/** Pavement outlines are simplified a little before triangulation. */
const PAVEMENT_SIMPLIFY_TOLERANCE_M = 0.35;
/** Pavements/pavement fragments smaller than this are not worth drawing. */
const PAVEMENT_MIN_AREA_M2 = 4;

/** Soft per-tile triangle caps keep one dense tile from dominating the frame. */
const MAX_KERB_TRIANGLES_PER_TILE = 1000;
const MAX_MARKING_TRIANGLES_PER_TILE = 3400;
const MAX_RAIL_TRIANGLES_PER_TILE = 1400;
const MAX_CROSSING_TRIANGLES_PER_TILE = 2200;
const MAX_MEDIAN_TRIANGLES_PER_TILE = 1400;
const MAX_BRIDGE_DETAIL_TRIANGLES_PER_TILE = 1600;

/** Painted markings stop this far from a CROSSING street's centreline, metres. */
const JUNCTION_CLEAR_M = 11;
/** Near a PARALLEL street's centreline (service aisle) markings stop earlier, m. */
const JUNCTION_PARALLEL_CLEAR_M = 4;
/** Distance from this way's own start/end that is treated as a junction, m. */
const JUNCTION_END_CLEAR_M = 7;
/** Coarse spatial grid used to test marking bars against junction points. */
const JUNCTION_GRID_M = 24;
/** Sampling step along other streets' centrelines for junction detection, m. */
const JUNCTION_SAMPLE_STEP_M = 8;

interface JunctionPoint {
  x: number;
  y: number;
  /** Unit direction of the sampled segment (for crossing/parallel tests). */
  ux: number;
  uy: number;
  /** Index of the road piece this point belongs to (bar source is excluded). */
  owner: number;
}

/** Per-tile data shared by the road emitters. */
interface RoadEmitContext {
  surfaces: RoadSurfaceRef[];
  crossings: readonly CrossingFeature[];
  junctionGrid: Map<string, JunctionPoint[]>;
}

/** Sample a centreline every `JUNCTION_SAMPLE_STEP_M` for junction tests. */
function sampleJunctionPoints(out: JunctionPoint[], points: readonly [number, number][], owner: number): void {
  out.push({ x: points[0][0], y: points[0][1], ux: 1, uy: 0, owner });
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (!(length > 1e-6)) continue;
    const ux = dx / length;
    const uy = dy / length;
    const steps = Math.max(1, Math.round(length / JUNCTION_SAMPLE_STEP_M));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      out.push({ x: a[0] + dx * t, y: a[1] + dy * t, ux, uy, owner });
    }
  }
}

function junctionKey(x: number, y: number): string {
  const cx = Math.floor(x / JUNCTION_GRID_M);
  const cy = Math.floor(y / JUNCTION_GRID_M);
  return `${cx},${cy}`;
}

function buildJunctionGrid(points: readonly JunctionPoint[]): Map<string, JunctionPoint[]> {
  const grid = new Map<string, JunctionPoint[]>();
  for (const point of points) {
    const key = junctionKey(point.x, point.y);
    const cell = grid.get(key);
    if (cell) cell.push(point);
    else grid.set(key, [point]);
  }
  return grid;
}

/**
 * True when a marking bar sits inside a junction box: within
 * `JUNCTION_CLEAR_M` of a CROSSING street's centreline (or a shorter distance
 * of a parallel one), or within `JUNCTION_END_CLEAR_M` of this way's own
 * start/end (ways are commonly split at junctions).
 */
function insideJunction(
  x: number,
  y: number,
  ux: number,
  uy: number,
  owner: number,
  stations: readonly PathStation[],
  context: RoadEmitContext,
): boolean {
  if (stations.length < 2) return false;
  const first = stations[0];
  const last = stations[stations.length - 1];
  const endClearSq = JUNCTION_END_CLEAR_M * JUNCTION_END_CLEAR_M;
  const dxFirst = x - first.x;
  const dyFirst = y - first.y;
  if (dxFirst * dxFirst + dyFirst * dyFirst < endClearSq) return true;
  const dxLast = x - last.x;
  const dyLast = y - last.y;
  if (dxLast * dxLast + dyLast * dyLast < endClearSq) return true;

  const crossingClearSq = JUNCTION_CLEAR_M * JUNCTION_CLEAR_M;
  const parallelClearSq = JUNCTION_PARALLEL_CLEAR_M * JUNCTION_PARALLEL_CLEAR_M;
  const cx = Math.floor(x / JUNCTION_GRID_M);
  const cy = Math.floor(y / JUNCTION_GRID_M);
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const cell = context.junctionGrid.get(`${gx},${gy}`);
      if (!cell) continue;
      for (const point of cell) {
        if (point.owner === owner) continue;
        const dx = x - point.x;
        const dy = y - point.y;
        // Bar and other-street direction are compared modulo direction (a
        // two-way street's OSM direction is arbitrary).
        const dot = Math.abs(ux * point.ux + uy * point.uy);
        const isCrossing = dot < 0.866; // > 30° apart
        if (dx * dx + dy * dy < (isCrossing ? crossingClearSq : parallelClearSq)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Tram ballast: a touch darker than the shared railway colour. */
const RAIL_BALLAST_COLOR = mixHex('#7b7367', '#5f5950', 0.35);
/** Rail heads: lighter, steel-ish. */
const RAIL_HEAD_COLOR = mixHex('#7b7367', '#b9b3a4', 0.55);

export interface RoadBuildStats {
  roadPolygons: number;
  pavementPolygons: number;
  railPolygons: number;
  roadTriangles: number;
  pavementTriangles: number;
  railTriangles: number;
  kerbTriangles: number;
  /** Lane-marking triangles (centre/dividers/edge/cycle paint). */
  markingTriangles: number;
  /** Marking bars emitted from a centreline. */
  markingBars: number;
  /** Legacy (rectangle-axis) dashes emitted for tiles without a centreline. */
  dashes: number;
  railSegments: number;
  bridges: number;
  tunnelsSkipped: number;
  skippedPolygons: number;
  degeneratePolygons: number;
  /** Road pieces that had a usable centreline. */
  centerlineRoads: number;
  /** Marking bars dropped because they fell inside a junction box. */
  markingBarsSkippedJunction: number;
  /** Pedestrian crossings / stop lines / signal heads. */
  crossings: CrossingStats;
  /** Derived medians on wide two-way avenues. */
  medians: MedianStats;
  /** Bridge parapets / posts / piers. */
  bridgeDetails: BridgeStats;
}

export function createRoadStats(): RoadBuildStats {
  return {
    roadPolygons: 0,
    pavementPolygons: 0,
    railPolygons: 0,
    roadTriangles: 0,
    pavementTriangles: 0,
    railTriangles: 0,
    kerbTriangles: 0,
    markingTriangles: 0,
    markingBars: 0,
    dashes: 0,
    railSegments: 0,
    bridges: 0,
    tunnelsSkipped: 0,
    skippedPolygons: 0,
    degeneratePolygons: 0,
    centerlineRoads: 0,
    markingBarsSkippedJunction: 0,
    crossings: createCrossingStats(),
    medians: createMedianStats(),
    bridgeDetails: createBridgeStats(),
  };
}

/** Emit all road records into the roads sink; never throws on bad entries. */
export function emitRoadPolygons(
  sink: GeometrySink,
  roads: RoadPolygon[] | null | undefined,
  crossings: CrossingFeature[] | null | undefined,
  bounds: Bounds4,
  stats: RoadBuildStats,
): void {
  if (!Array.isArray(roads) || roads.length === 0) return;

  // Phase 1: prepare every polygon once (markings and crossings clip against
  // the same prepared rings, so preparing twice would double the tile cost).
  interface PreparedRoad {
    road: RoadPolygon;
    prepared: PreparedPolygon;
    index: number;
  }
  const preparedRoads: PreparedRoad[] = [];
  for (let index = 0; index < roads.length; index++) {
    const road = roads[index];
    if (!road || !Array.isArray(road.polygon)) {
      stats.skippedPolygons++;
      continue;
    }
    if (road.tunnel) {
      stats.tunnelsSkipped++;
      continue;
    }
    let prepared: PreparedPolygon | null = null;
    try {
      prepared = prepareFlatPolygon(road.polygon as Polygon, { minArea: MIN_RING_AREA_M2 });
    } catch {
      prepared = null;
    }
    if (!prepared) {
      stats.degeneratePolygons++;
      continue;
    }
    if (!ringTouchesBounds(prepared.exterior, bounds)) {
      stats.skippedPolygons++;
      continue;
    }
    preparedRoads.push({ road, prepared, index });
  }
  if (preparedRoads.length === 0) return;

  // Every drivable carriageway of the tile, for crossing lookup and junction
  // detection (medians must not run through another street).
  const surfaces: RoadSurfaceRef[] = [];
  for (const entry of preparedRoads) {
    if (roadTier(entry.road) !== 'road') continue;
    if (entry.road.bridge) continue;
    const [minX, minY, maxX, maxY] = ringBounds(entry.prepared.exterior);
    surfaces.push({
      road: entry.road,
      prepared: entry.prepared,
      width: effectiveWidth(entry.road),
      bbox: [minX, minY, maxX, maxY],
    });
  }

  // Phase 2: emit.
  // Junction clearance: lane/edge/centre paint must stop at the junction box,
  // not run through it. We sample every other street's centreline into a coarse
  // grid and drop marking bars that fall within JUNCTION_CLEAR_M of it.
  const junctionPoints: JunctionPoint[] = [];
  for (const entry of preparedRoads) {
    if (roadTier(entry.road) !== 'road' || entry.road.bridge) continue;
    const points = centerlinePoints(entry.road.centerline);
    if (points.length < 2) continue;
    sampleJunctionPoints(junctionPoints, points, entry.index);
  }
  const junctionGrid = buildJunctionGrid(junctionPoints);
  const context: RoadEmitContext = {
    surfaces,
    crossings: crossings ?? [],
    junctionGrid,
  };

  for (const entry of preparedRoads) {
    try {
      emitRoad(sink, entry.road, entry.prepared, entry.index, stats, context);
    } catch {
      // Defensive: odd data must never break the whole tile.
      stats.skippedPolygons++;
    }
  }

  // Crossings are emitted last so their paint sits above the lane markings of
  // every road they cross.
  try {
    emitCrossings(
      sink,
      crossings,
      surfaces,
      stats.crossings,
      MAX_CROSSING_TRIANGLES_PER_TILE,
    );
  } catch {
    // Defensive: a broken crossing record must not drop the whole tile.
  }
}

function emitRoad(
  sink: GeometrySink,
  road: RoadPolygon,
  prepared: PreparedPolygon,
  index: number,
  stats: RoadBuildStats,
  context: RoadEmitContext,
): void {
  const tier = roadTier(road);
  if (tier === 'rail') {
    emitRail(sink, road, prepared, index, stats);
    return;
  }
  if (tier === 'pavement') {
    emitPavement(sink, road, prepared, index, stats);
    return;
  }
  emitCarRoad(sink, road, prepared, index, stats, context);
}

function effectiveWidth(road: RoadPolygon): number {
  if (Number.isFinite(road.width) && road.width > 0.5) return road.width;
  return ROAD_WIDTH_M[road.class] ?? ROAD_WIDTH_M.unknown;
}

function roadColor(road: RoadPolygon): string {
  return roadSurfaceColor(road) ?? ROAD_PALETTE[road.class] ?? ROAD_PALETTE.unknown;
}

function roadStations(road: RoadPolygon): PathStation[] {
  const points = centerlinePoints(road.centerline);
  if (points.length < 2) return [];
  return samplePath(points, 1.6);
}

function emitPavement(
  sink: GeometrySink,
  road: RoadPolygon,
  prepared: PreparedPolygon,
  index: number,
  stats: RoadBuildStats,
): void {
  if (prepared.area < PAVEMENT_MIN_AREA_M2) {
    stats.skippedPolygons++;
    return;
  }
  // Thin strips tolerate a little simplification very well and it pays for
  // itself: pavements are the most numerous road polygons on central tiles.
  const renderable = simplifyPreparedPolygon(prepared, PAVEMENT_SIMPLIFY_TOLERANCE_M);
  const triangles = triangulatePrepared(renderable);
  if (triangles.length === 0) {
    stats.degeneratePolygons++;
    return;
  }
  const y = layerY('sidewalk', index);
  const color = road.class === 'cycleway' ? cyclewayColor() : roadColor(road);
  if (road.bridge) {
    const deckY = y + BRIDGE_RAISE_M;
    stats.pavementTriangles += sink.addFlatTriangles(triangles, deckY, color);
    stats.pavementTriangles += emitBridgeSides(sink, prepared, deckY, color);
    stats.bridges++;
  } else {
    stats.pavementTriangles += sink.addFlatTriangles(triangles, y, color);
  }
  stats.pavementPolygons++;
}

function emitCarRoad(
  sink: GeometrySink,
  road: RoadPolygon,
  prepared: PreparedPolygon,
  index: number,
  stats: RoadBuildStats,
  context: RoadEmitContext,
): void {
  const triangles = triangulatePrepared(prepared);
  if (triangles.length === 0) {
    stats.degeneratePolygons++;
    return;
  }
  const width = effectiveWidth(road);
  const color = roadColor(road);
  const y = layerY('road', index);
  const stations = roadStations(road);
  if (stations.length >= 2) stats.centerlineRoads++;

  if (road.bridge) {
    // Choice: bridges are raised decks without ramps (BRIDGE_RAISE_M ≈ 2.5 m)
    // plus a vertical skirt down to ground so the slab never floats.
    const deckY = y + BRIDGE_RAISE_M;
    stats.roadTriangles += sink.addFlatTriangles(triangles, deckY, color);
    stats.roadTriangles += emitBridgeSides(sink, prepared, deckY, color);
    stats.roadPolygons++;
    stats.bridges++;
    if (stations.length >= 2) {
      emitBridgeDetails(
        sink,
        road,
        prepared,
        stations,
        deckY,
        stats.bridgeDetails,
        MAX_BRIDGE_DETAIL_TRIANGLES_PER_TILE,
      );
    }
    return;
  }

  stats.roadTriangles += sink.addFlatTriangles(triangles, y, color);
  stats.roadPolygons++;

  if (
    KERB_CLASSES.has(road.class) &&
    width >= KERB_MIN_WIDTH_M &&
    prepared.area >= KERB_MIN_AREA_M2 &&
    stats.kerbTriangles < MAX_KERB_TRIANGLES_PER_TILE
  ) {
    stats.kerbTriangles += emitKerb(sink, prepared, road.class, stats);
  }

  // Medians run between the directions, so they must be derived before (and
  // independently of) the centre-line paint; the paint hides beneath them.
  if (stations.length >= 2) {
    emitMedian(
      sink,
      road,
      prepared,
      stations,
      context.surfaces,
      context.crossings,
      y,
      stats.medians,
      MAX_MEDIAN_TRIANGLES_PER_TILE,
    );
  }

  if (stations.length >= 2) {
    const bars = laneMarkings(road, prepared, stations);
    const markingY = layerY('markings', index);
    for (const bar of bars) {
      if (stats.markingTriangles + 2 > MAX_MARKING_TRIANGLES_PER_TILE) break;
      if (insideJunction(bar.cx, bar.cy, bar.ux, bar.uy, index, stations, context)) {
        stats.markingBarsSkippedJunction++;
        continue;
      }
      const barColor = bar.tone === 'bike' ? BIKE_LANE_COLOR : MARKING_BAR_COLOR;
      if (addBar(sink, bar, markingY, barColor)) {
        stats.markingTriangles += 2;
        stats.markingBars++;
      }
    }
  } else if (
    DASH_MARKING_CLASSES.has(road.class) &&
    stats.markingTriangles < MAX_MARKING_TRIANGLES_PER_TILE
  ) {
    // Legacy tiles (pipeline < 0.2.0): single dashed axis from the polygon's
    // minimum-area rectangle. Kept so old city tiles still look reasonable.
    const dashes = roadDashes(prepared, road.class, width);
    const dashY = layerY('markings', index);
    for (const dash of dashes) {
      if (stats.markingTriangles + 2 > MAX_MARKING_TRIANGLES_PER_TILE) break;
      const halfLength = dash.length / 2;
      const halfWidth = dash.width / 2;
      const px = -dash.uy;
      const py = dash.ux;
      const ax = dash.cx - dash.ux * halfLength - px * halfWidth;
      const ay = dash.cy - dash.uy * halfLength - py * halfWidth;
      const bx = dash.cx + dash.ux * halfLength - px * halfWidth;
      const by = dash.cy + dash.uy * halfLength - py * halfWidth;
      const cx = dash.cx + dash.ux * halfLength + px * halfWidth;
      const cy = dash.cy + dash.uy * halfLength + py * halfWidth;
      const dx = dash.cx - dash.ux * halfLength + px * halfWidth;
      const dy = dash.cy - dash.uy * halfLength + py * halfWidth;
      if (sink.addFlatQuad([ax, ay], [bx, by], [cx, cy], [dx, dy], dashY, MARKING_BAR_COLOR)) {
        stats.markingTriangles += 2;
        stats.dashes++;
      }
    }
  }
}

/** Dark shoulder strip around a road polygon, at its own layer under the road. */
function emitKerb(
  sink: GeometrySink,
  prepared: PreparedPolygon,
  roadClass: RoadClass,
  stats: RoadBuildStats,
): number {
  let ring = simplifyRing(prepared.exterior, KERB_SIMPLIFY_TOLERANCE_M);
  let tolerance = KERB_SIMPLIFY_TOLERANCE_M;
  for (let attempt = 0; attempt < 4 && ring.length > KERB_MAX_EDGES; attempt++) {
    tolerance *= 2;
    ring = simplifyRing(prepared.exterior, tolerance);
  }
  if (ring.length < 3 || ring.length > 256) return 0;
  const outer = offsetRingOutward(ring, KERB_WIDTH_M);
  if (!outer || outer.length !== ring.length) return 0;
  const color = mixHex(ROAD_PALETTE[roadClass] ?? ROAD_PALETTE.unknown, SIDEWALK_COLOR, 0.45);
  const y = ENV_LAYER_Y.kerb;
  let added = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    if (sink.addFlatQuad(ring[i], ring[j], outer[j], outer[i], y, color)) added += 2;
    if (stats.kerbTriangles + added >= MAX_KERB_TRIANGLES_PER_TILE) break;
  }
  return added;
}

/** Vertical walls from a raised deck down to the ground plane. */
function emitBridgeSides(
  sink: GeometrySink,
  prepared: PreparedPolygon,
  deckY: number,
  topColor: string,
): number {
  const color = mixHex(topColor, '#2f3236', 0.35);
  const rings: PreparedPolygon['exterior'][] = [prepared.exterior];
  for (const hole of prepared.holes) {
    // Hole walls are seen from inside the hole, so orient the ring clockwise
    // before deriving the outward (here: inwards) direction.
    const oriented = signedRingArea(hole) > 0 ? [...hole].reverse() : hole;
    rings.push(oriented);
  }
  const before = sink.triangleCount;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (!(length > 1e-6)) continue;
      const outward: Vec3 = [dy / length, 0, dx / length];
      const topA: Vec3 = [a[0], deckY, -a[1]];
      const topB: Vec3 = [b[0], deckY, -b[1]];
      const bottomA: Vec3 = [a[0], 0, -a[1]];
      const bottomB: Vec3 = [b[0], 0, -b[1]];
      sink.addOrientedQuad(topA, topB, bottomB, bottomA, outward, color);
    }
  }
  return sink.triangleCount - before;
}

/** Rail / tram polygon: ballast strip + two light rail lines. */
function emitRail(
  sink: GeometrySink,
  road: RoadPolygon,
  prepared: PreparedPolygon,
  index: number,
  stats: RoadBuildStats,
): void {
  const triangles = triangulatePrepared(prepared);
  if (triangles.length === 0) {
    stats.degeneratePolygons++;
    return;
  }
  const raise = road.bridge ? BRIDGE_RAISE_M : 0;
  const ballastY = layerY('railBallast', index) + raise;
  const railY = layerY('railTrack', index) + raise;
  stats.railTriangles += sink.addFlatTriangles(triangles, ballastY, RAIL_BALLAST_COLOR);
  if (road.bridge) {
    stats.railTriangles += emitBridgeSides(sink, prepared, ballastY, RAIL_BALLAST_COLOR);
    stats.bridges++;
  }

  const layout = railLineLayout(prepared, effectiveWidth(road));
  for (const segment of layout.segments) {
    if (stats.railTriangles >= MAX_RAIL_TRIANGLES_PER_TILE) break;
    const dx = segment.x1 - segment.x0;
    const dy = segment.y1 - segment.y0;
    const length = Math.hypot(dx, dy);
    if (!(length > 1e-6)) continue;
    const ux = dx / length;
    const uy = dy / length;
    const px = -uy;
    const py = ux;
    const half = segment.width / 2;
    const ax = segment.x0 + px * half;
    const ay = segment.y0 + py * half;
    const bx = segment.x1 + px * half;
    const by = segment.y1 + py * half;
    const cx = segment.x1 - px * half;
    const cy = segment.y1 - py * half;
    const dx2 = segment.x0 - px * half;
    const dy2 = segment.y0 - py * half;
    if (sink.addFlatQuad([ax, ay], [bx, by], [cx, cy], [dx2, dy2], railY, RAIL_HEAD_COLOR)) {
      stats.railTriangles += 2;
      stats.railSegments++;
    }
  }
  stats.railPolygons++;
}
