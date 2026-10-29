/**
 * Road / pavement / tram-rail meshes for one tile.
 *
 * The pipeline hands us buffered centreline polygons (already the correct
 * width). This module renders:
 *  - drivable polygons flat at the road layer with `ROAD_PALETTE` colours;
 *  - footways / cycleways / paths at the sidewalk layer;
 *  - a subtle dark kerb strip around wider streets (0.6 m, its own layer just
 *    under the road so it can never z-fight the asphalt or the pavements);
 *  - dashed centre lines for avenue-class roads, derived from the minimum-area
 *    bounding rectangle long axis (see roadAnalysis.ts), skipped when the road
 *    is too narrow/short;
 *  - rail/tram polygons as a dark ballast strip plus two light rail lines;
 *  - bridges as raised decks (BRIDGE_RAISE_M, no ramps) with a vertical skirt
 *    down to the ground so nothing floats in mid air;
 *  - tunnels not at all.
 *
 * All flat geometry is merged into the single `roads` sink of the tile.
 */

import type { Polygon, RoadClass, RoadPolygon } from '../../shared/types';
import { ROAD_PALETTE, ROAD_WIDTH_M, SIDEWALK_COLOR, mixHex, shadeHex } from '../../engine/materials/palette';
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
import { offsetRingOutward, railLineLayout, roadDashes } from './roadAnalysis';

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
const MAX_MARKING_TRIANGLES_PER_TILE = 900;
const MAX_RAIL_TRIANGLES_PER_TILE = 1400;

/** Painted lane marking tint: warm off-white derived from the pavement colour. */
const MARKING_COLOR = shadeHex(SIDEWALK_COLOR, 0.55);
/** Tram ballast: a touch darker than the shared railway colour. */
const RAIL_BALLAST_COLOR = shadeHex('#7b7367', -0.18);
/** Rail heads: lighter, steel-ish. */
const RAIL_HEAD_COLOR = shadeHex('#7b7367', 0.55);

export interface RoadBuildStats {
  roadPolygons: number;
  pavementPolygons: number;
  railPolygons: number;
  roadTriangles: number;
  pavementTriangles: number;
  railTriangles: number;
  kerbTriangles: number;
  markingTriangles: number;
  dashes: number;
  railSegments: number;
  bridges: number;
  tunnelsSkipped: number;
  skippedPolygons: number;
  degeneratePolygons: number;
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
    dashes: 0,
    railSegments: 0,
    bridges: 0,
    tunnelsSkipped: 0,
    skippedPolygons: 0,
    degeneratePolygons: 0,
  };
}

/** Emit all road records into the roads sink; never throws on bad entries. */
export function emitRoadPolygons(
  sink: GeometrySink,
  roads: RoadPolygon[] | null | undefined,
  bounds: Bounds4,
  stats: RoadBuildStats,
): void {
  if (!Array.isArray(roads) || roads.length === 0) return;
  for (let index = 0; index < roads.length; index++) {
    const road = roads[index];
    if (!road || !Array.isArray(road.polygon)) {
      stats.skippedPolygons++;
      continue;
    }
    try {
      emitRoad(sink, road, index, bounds, stats);
    } catch {
      // Defensive: odd data must never break the whole tile.
      stats.skippedPolygons++;
    }
  }
}

function emitRoad(
  sink: GeometrySink,
  road: RoadPolygon,
  index: number,
  bounds: Bounds4,
  stats: RoadBuildStats,
): void {
  // Tunnels are not rendered at all (no hole in the ground, no deck).
  if (road.tunnel) {
    stats.tunnelsSkipped++;
    return;
  }
  const prepared = prepareFlatPolygon(road.polygon as Polygon, { minArea: MIN_RING_AREA_M2 });
  if (!prepared) {
    stats.degeneratePolygons++;
    return;
  }
  if (!ringTouchesBounds(prepared.exterior, bounds)) {
    stats.skippedPolygons++;
    return;
  }

  const tier = roadTier(road);
  if (tier === 'rail') {
    emitRail(sink, road, prepared, index, stats);
    return;
  }
  if (tier === 'pavement') {
    emitPavement(sink, road, prepared, index, stats);
    return;
  }
  emitCarRoad(sink, road, prepared, index, stats);
}

function effectiveWidth(road: RoadPolygon): number {
  if (Number.isFinite(road.width) && road.width > 0.5) return road.width;
  return ROAD_WIDTH_M[road.class] ?? ROAD_WIDTH_M.unknown;
}

function roadColor(road: RoadPolygon): string {
  return ROAD_PALETTE[road.class] ?? ROAD_PALETTE.unknown;
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
  const color = roadColor(road);
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
): void {
  const triangles = triangulatePrepared(prepared);
  if (triangles.length === 0) {
    stats.degeneratePolygons++;
    return;
  }
  const width = effectiveWidth(road);
  const color = roadColor(road);
  const y = layerY('road', index);

  if (road.bridge) {
    // Choice: bridges are raised decks without ramps (BRIDGE_RAISE_M ≈ 2.5 m)
    // plus a vertical skirt down to ground so the slab never floats.
    const deckY = y + BRIDGE_RAISE_M;
    stats.roadTriangles += sink.addFlatTriangles(triangles, deckY, color);
    stats.roadTriangles += emitBridgeSides(sink, prepared, deckY, color);
    stats.roadPolygons++;
    stats.bridges++;
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

  if (
    DASH_MARKING_CLASSES.has(road.class) &&
    stats.markingTriangles < MAX_MARKING_TRIANGLES_PER_TILE
  ) {
    const dashes = roadDashes(prepared, road.class, width);
    const dashY = layerY('markings', index);
    for (const dash of dashes) {
      if (stats.markingTriangles >= MAX_MARKING_TRIANGLES_PER_TILE) break;
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
      if (sink.addFlatQuad([ax, ay], [bx, by], [cx, cy], [dx, dy], dashY, MARKING_COLOR)) {
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
  const color = shadeHex(topColor, -0.28);
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
