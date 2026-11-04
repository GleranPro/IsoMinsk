/**
 * Semantic road markings and tram rails for payload 0.3.0.
 *
 * The pipeline gives real centrelines (`RoadNetworkPiece.centerline`, already
 * overhanging the tile by ~4 m), OSM-graph junctions with a single asphalt face
 * polygon and pedestrian crossings. This module turns them into flat geometry
 * just above the road surface:
 *
 *  - **lane markings** — a per-direction layout (`laneMarkingLayout`) driven by
 *    tagged `lanesForward`/`lanesBackward` (asymmetric centre line), a double
 *    solid centre on wide two-way roads, dashed lane dividers per direction and
 *    solid edge lines on the major classes. Every drivable asphalt class is
 *    painted except slip links (`link`), roundabout rings and service aisles,
 *    which get no centre/divider paint at all. Bridge decks are raised by
 *    `BRIDGE_RAISE_M` and use the tile's bridge asphalt pieces for containment.
 *    Dashes are phase anchored to the arc length along the source way
 *    (`centerlineOffset + station`) so their rhythm is continuous across tiles;
 *    solids are emitted as 2 m chunks on the same global grid. Every paint
 *    element is owned by the tile whose bounds contain its centre (half-open),
 *    so an element straddling a tile border is emitted exactly once.
 *  - **junction faces** — payload 0.3.0 junctions carry a polygon ring; paint is
 *    clipped out of the polygon buffered by 0.5 m **plus half the paint
 *    element's length** (bbox prefilter + point in polygon / boundary distance),
 *    so the far half of a 2 m solid chunk or 3 m dash cannot reach the face.
 *    This replaces the circle model for 0.3.0. Junctions without a usable face
 *    polygon keep the radius clearance path (legacy 0.2.0 tiles); a
 *    `fallback: true` union-of-mouth rectangle is still used as a clip polygon.
 *    `junction: true` asphalt surface pieces are a **hard exclusion** as well:
 *    paint is clipped chunk-aware against them even when their junction record
 *    polygon was dropped (sub-1 m² face slivers).
 *  - **zebra bars / stop lines** — crossing paint is clipped to the tile's
 *    drivable asphalt/stone pieces; zebra bars are skipped where their centre
 *    falls inside a junction face polygon. Stop lines come from the junction's
 *    `approachEdges[].stopLine` bars when present (painted exactly once by the
 *    owning tile); the legacy crossing-based stop lines are suppressed where an
 *    explicit approach stop line exists and kept otherwise.
 *  - **tram rails** — `kind === 'rail'` network pieces become a ballast strip
 *    plus two rail heads. The strip geometry is clipped to the tile bounds, so
 *    the per-tile pieces (which overhang each other by 4 m) render exactly once
 *    and meet seamlessly at tile borders; rails get no junction/crossing
 *    clearance and no lane paint.
 *
 * Junction faces and legacy junction circles suppress every paint type; crossings
 * suppress dashed paint (and solid chunks crossing their paint). Every paint
 * corner inside the tile must lie in a drivable asphalt piece — corners
 * overhanging into the neighbouring tile are ignored (their asphalt lives
 * there), which keeps paint continuous across tile seams. Hard per-tile budgets
 * keep dense tiles cheap: 8192 triangles of lane/junction paint and 600 triangles
 * of zebra bars, truncated deterministically in payload order.
 */

import type {
  CrossingFeature,
  JunctionFeature,
  Ring,
  RoadClass,
  RoadMaterial,
  RoadNetworkPiece,
  TileData,
} from '../../shared/types';
import { MARKING_COLOR, MARKING_COLOR_DIM } from '../../engine/materials/palette';
import { ringBounds } from '../../shared/tileMath';
import {
  BRIDGE_RAISE_M,
  ENV_LAYER_Y,
  LAYER_JITTER_STEP_M,
  type Bounds4,
} from '../environment/envLayers';
import type { GeometrySink } from '../environment/meshBuilder';
import { prepareFlatPolygon, type PreparedPolygon } from '../environment/triangulate';
import { pointInPreparedPolygon, RAIL_LINE_WIDTH_M, type Point2 } from './roadAnalysis';
import { centerlinePoints, pathLength, stationAt, type PathStation } from './roadPath';
import { RAIL_BALLAST_COLOR, RAIL_HEAD_COLOR } from './roadColors';

// ---------------------------------------------------------------------------
// Lane-marking layout tuning (metres)
// ---------------------------------------------------------------------------

/** Dashed centre line: 3 m dash / 7 m period / 0.5 m wide. */
const CENTRE_DASH_LENGTH_M = 3;
const CENTRE_DASH_SPACING_M = 7;
const CENTRE_DASH_WIDTH_M = 0.5;
/** Centre line only on two-way carriageways at least this wide. */
const TWO_WAY_CENTRE_MIN_WIDTH_M = 5.5;
/** Double solid centre line on two-way carriageways at least this wide. */
const DOUBLE_SOLID_MIN_WIDTH_M = 12.5;
const DOUBLE_SOLID_OFFSET_M = 0.25;
const DOUBLE_SOLID_WIDTH_M = 0.15;

/** Lane dividers: 2 m dash / 6 m period / 0.15 m wide. */
const LANE_DASH_LENGTH_M = 2;
const LANE_DASH_SPACING_M = 6;
const LANE_DASH_WIDTH_M = 0.15;

/**
 * Lane pitch used to place dividers on an asymmetric piece: derive it from the
 * verified carriageway width, clamped to a plausible passenger-car lane width.
 */
const LANE_WIDTH_M = 3.0;
const LANE_WIDTH_MIN_M = 2.6;
const LANE_WIDTH_MAX_M = 3.4;
/** Width not available for lanes (kerb/shoulder allowance), metres. */
const LANE_TOTAL_MARGIN_M = 0.6;
/** Absolute lane-count guard: no piece may paint more than this per direction. */
const ABS_MAX_LANES = 8;
/** Upper lane-count sanity bound: one lane per 2.2 m of width, plus one. */
const MIN_LANE_SPACE_M = 2.2;

/** Edge lines: solid 0.15 m, 0.4 m inside each carriageway edge. */
const EDGE_LINE_WIDTH_M = 0.15;
const EDGE_LINE_INSET_M = 0.4;
/** Edge lines only on the major classes and on wider carriageways. */
const EDGE_LINE_MIN_WIDTH_M = 7;
const EDGE_LINE_CLASSES: ReadonlySet<RoadClass> = new Set<RoadClass>([
  'motorway',
  'trunk',
  'primary',
  'secondary',
]);

/** Solid lines are emitted as short chunks on a global grid, metres. */
const SOLID_CHUNK_M = 2;
/** Solid chunks shorter than this at a piece end are dropped, metres. */
const MIN_SOLID_CHUNK_M = 0.25;

/** Junction face paint clearance beyond the polygon, metres. */
const JUNCTION_FACE_CLEARANCE_M = 0.5;
/** Legacy junction radius clearance beyond the radius, metres. */
const JUNCTION_CLEARANCE_M = 0.5;
/** How close a crossing must be to a junction for stop-line matching, metres. */
const APPROACH_STOP_LINE_MATCH_M = 30;
/** Max angle difference for matching an explicit approach stop line, radians. */
const APPROACH_STOP_LINE_ANGLE_RAD = (45 * Math.PI) / 180;
/** Minimum dash clearance around a crossing of the same road, metres. */
const CROSSING_CLEARANCE_MIN_M = 2.5;
/** Clearance beyond the crossing half-span, metres. */
const CROSSING_CLEARANCE_PAD_M = 1.0;
/** A crossing belongs to this road when its angle differs by <= 30°. */
const CROSSING_ROAD_ANGLE_RAD = (30 * Math.PI) / 180;
/** Corners closer than this to the tile border are tested against the tile. */
const CORNER_TILE_MARGIN_M = 0.01;
/** Safety caps so pathological geometry cannot explode the tile build. */
const MAX_ELEMENTS_PER_LINE = 4096;
const MAX_SOLID_CHUNKS_PER_LINE = 4096;

/** Zebra bar layout, metres. */
const ZEBRA_BAR_WIDTH_M = 0.5;
const ZEBRA_STEP_M = 1.0;
/** Inset from the carriageway edge to the first zebra bar, metres. */
const ZEBRA_EDGE_INSET_M = 0.55;
/** Stop line thickness along the road, metres. */
const STOP_LINE_WIDTH_M = 0.5;
/**
 * Stop lines are inset from the carriageway edge so their corners sit safely
 * inside the drivable asphalt (the pipeline buffers/simplification can cut the
 * nominal edge by a few decimetres; a corner exactly on the boundary is
 * ambiguous and would drop the line).
 */
const STOP_LINE_EDGE_INSET_M = 0.4;
/** Gap between crossing edge and stop line, metres. */
const STOP_LINE_GAP_M = 0.7;
const DEFAULT_CROSSING_SPAN_M = 4;

/** Paint budgets per tile, triangles. */
export const MAX_MARKING_TRIANGLES_PER_TILE = 8192;
export const MAX_ZEBRA_TRIANGLES_PER_TILE = 600;

/**
 * Crossing paint height.
 *
 * Lane paint sits exactly at `ENV_LAYER_Y.markings`. Crossing paint (zebra bars
 * and stop lines) can geometrically overlap lane paint — mid-block crossings
 * and stop lines cross the centre line — so the two paint families must not be
 * coplanar or they z-fight. Crossings use the next sub-level of the markings
 * layer (the same 1.5 mm step the layer jitter uses, >2× the depth resolution of
 * the isometric camera), which keeps the "every flat surface sits in exactly one
 * layer band" invariant intact.
 */
export const CROSSING_PAINT_Y = ENV_LAYER_Y.markings + LAYER_JITTER_STEP_M;
/**
 * Stop lines sit one more millimetre above the zebra bars: a stop line and a
 * zebra bar of *different* crossings can overlap in plan near a junction, and
 * coplanar white-vs-dim quads would z-fight. The separation is another ~1.4×
 * the camera depth resolution and still leaves >6 mm below the rail track.
 */
export const CROSSING_STOP_LINE_Y = CROSSING_PAINT_Y + 0.001;

/** Tram/rail geometry tuning, metres. */
const RAIL_BALLAST_MIN_WIDTH_M = 2.0;
const RAIL_HEAD_OFFSET_M = 0.75;
const RAIL_SAMPLE_STEP_M = 3.0;
const MAX_RAIL_SEGMENTS_PER_PIECE = 4096;

/** Crossings are painted only on these surfaces. */
const PAINTED_CROSSING_MATERIALS: ReadonlySet<RoadMaterial> = new Set<RoadMaterial>([
  'asphalt',
  'stone',
]);
/** Lane paint is only drawn on asphalt drivable pieces. */
const ASPHALT_ONLY: readonly RoadMaterial[] = ['asphalt'];
/** Crossing paint may sit on both paved drivable materials. */
const PAVED_MATERIALS: readonly RoadMaterial[] = ['asphalt', 'stone'];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Tile slice needed by the network pass. */
export type RoadNetworkSource = Pick<
  TileData,
  'roadSurfaces' | 'roadNetwork' | 'junctions' | 'crossings'
>;

/** Counters for the road network marking + rail pass. */
export interface RoadNetworkStats {
  /** Network pieces inspected. */
  pieces: number;
  /** Road pieces that emitted at least one paint element. */
  paintedPieces: number;
  /** Pieces that emitted at least one dashed element. */
  dashedPieces: number;
  /** Dashed paint elements (centre dashes + lane dividers). */
  dashes: number;
  /** Solid paint chunks (centre lines, edge lines). */
  solidChunks: number;
  /** Paint elements rejected because their centre is outside the tile. */
  boundsSkipped: number;
  /** Paint elements rejected by a legacy junction clearance radius. */
  junctionSkipped: number;
  /** Paint elements rejected inside a 0.3.0 junction face polygon (+0.5 m). */
  junctionFaceSkipped: number;
  /**
   * Paint elements rejected inside a `junction: true` asphalt surface piece
   * (chunk-aware). These are hard exclusions even when the junction record's
   * face polygon was dropped by the pipeline.
   */
  junctionSurfaceSkipped: number;
  /** Paint elements rejected around a crossing of the same road. */
  crossingClearanceSkipped: number;
  /** Paint elements rejected because a corner left the drivable asphalt. */
  containmentSkipped: number;
  /** Malformed network records. */
  skippedPieces: number;
  /** Painted crossings (zebra / signals) processed. */
  crossings: number;
  /** Crossings rejected because of missing/invalid data or material. */
  crossingsSkipped: number;
  zebraBars: number;
  /** Zebra bars dropped because their centre is inside a junction face. */
  zebraJunctionSkipped: number;
  stopLines: number;
  /** Stop lines painted from `junction.approachEdges[].stopLine`. */
  approachStopLines: number;
  /** Legacy crossing stop lines suppressed by an explicit approach stop line. */
  legacyStopLinesSuppressed: number;
  /** Zebra bars / stop lines dropped because a corner left the drivable pavement. */
  crossingContainmentSkipped: number;
  /** Stop lines dropped because their centre is inside a junction. */
  stopLineJunctionSkipped: number;
  /** Triangles of lane/junction paint (dashes + solids + stop lines). */
  markingTriangles: number;
  /** Triangles of zebra bars. */
  zebraTriangles: number;
  /** Rail pieces that emitted geometry. */
  railPieces: number;
  /** Rail path segments that emitted a ballast/head strip. */
  railSegments: number;
  /** Triangles of rail ballast + rail heads. */
  railTriangles: number;
  /** True when a per-tile budget truncated the output. */
  capped: boolean;
}

export function createRoadNetworkStats(): RoadNetworkStats {
  return {
    pieces: 0,
    paintedPieces: 0,
    dashedPieces: 0,
    dashes: 0,
    solidChunks: 0,
    boundsSkipped: 0,
    junctionSkipped: 0,
    junctionFaceSkipped: 0,
    junctionSurfaceSkipped: 0,
    crossingClearanceSkipped: 0,
    containmentSkipped: 0,
    skippedPieces: 0,
    crossings: 0,
    crossingsSkipped: 0,
    zebraBars: 0,
    zebraJunctionSkipped: 0,
    stopLines: 0,
    approachStopLines: 0,
    legacyStopLinesSuppressed: 0,
    crossingContainmentSkipped: 0,
    stopLineJunctionSkipped: 0,
    markingTriangles: 0,
    zebraTriangles: 0,
    railPieces: 0,
    railSegments: 0,
    railTriangles: 0,
    capped: false,
  };
}

/** One paint line of the lane layout (constant lateral offset along the piece). */
export interface PaintLine {
  kind: 'centre' | 'divider' | 'edge';
  /** Lateral offset from the centreline, metres; positive = left of travel. */
  offset: number;
  /** Dashed (gapped) or solid (contiguous chunks). */
  dashed: boolean;
  /** Element length along the road, metres. */
  length: number;
  /** Dash period for dashed lines (`length` + gap); unused for solids. */
  spacing: number;
  /** Paint width, metres. */
  width: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A prepared drivable piece of one bridge flag, reusable for containment. */
interface PreparedPiece {
  prepared: PreparedPolygon;
  bbox: Bounds4;
}

/** A junction asphalt face prepared for paint clipping. */
interface JunctionFace {
  prepared: PreparedPolygon;
  /** Exterior bounds (unexpanded; callers extend by their element clearance). */
  bbox: Bounds4;
  /** Exterior ring first, holes after; used for the boundary buffer test. */
  rings: Ring[];
}

/** One junction record plus its prepared face (when the payload has one). */
interface JunctionInfo {
  feature: JunctionFeature;
  face: JunctionFace | null;
}

/** All junction-derived data needed by one tile pass. */
interface JunctionContext {
  infos: JunctionInfo[];
  /** Junction face polygons from the junction records. */
  faces: JunctionFace[];
  /**
   * `junction: true` asphalt surface pieces. Hard paint exclusions even when no
   * junction record polygon survived (e.g. sub-1 m² face slivers).
   */
  surfaces: JunctionFace[];
  /** Junctions without a usable face polygon (legacy 0.2.0 tiles). */
  legacy: JunctionFeature[];
  /** Explicit approach stop bars from payload 0.3.0 (`approachEdges`). */
  approachStopLines: Array<{
    x: number;
    y: number;
    angle: number;
    width: number;
    /** Junction centre: the tile containing it paints all its approach bars. */
    ownerX: number;
    ownerY: number;
  }>;
}

/** A crossing of this road, with the radius lane paint must keep clear of. */
interface CrossingClearance {
  x: number;
  y: number;
  /** Road direction at the crossing, radians. */
  angle: number;
  radius: number;
}

/** Paint containment sets, split by bridge flag. */
interface ContainmentSets {
  groundAsphalt: PreparedPiece[];
  bridgeAsphalt: PreparedPiece[];
  groundCrossing: PreparedPiece[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Emit lane paint, crossings and tram rails for one tile into the shared roads
 * sink. Never throws: malformed records are counted and skipped.
 */
export function emitRoadNetwork(
  sink: GeometrySink,
  tile: RoadNetworkSource | null | undefined,
  bounds: Bounds4,
  stats: RoadNetworkStats,
): void {
  if (!tile) return;

  const containment = prepareContainment(tile.roadSurfaces);
  const junctions = prepareJunctions(tile.junctions, tile.roadSurfaces);
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
      if (piece.kind === 'rail') {
        emitRailPiece(sink, piece, bounds, stats);
      } else if (piece.kind === 'road' && piece.material === 'asphalt') {
        emitLanePaint(
          sink,
          piece,
          bounds,
          junctions,
          crossingClearances,
          containment,
          stats,
        );
      }
    } catch {
      stats.skippedPieces++;
    }
  }

  // Explicit junction approach stop bars (payload 0.3.0). Emitted before the
  // legacy crossing paint so the budget priority goes to the authoritative data.
  try {
    emitJunctionStopLines(sink, junctions, bounds, stats);
  } catch {
    // Defensive: a malformed stop bar must not break the tile.
  }

  const crossings = Array.isArray(tile.crossings) ? tile.crossings : [];
  for (let index = 0; index < crossings.length; index++) {
    try {
      emitCrossing(sink, crossings[index], junctions, containment, stats);
    } catch {
      stats.crossingsSkipped++;
    }
  }
}

// ---------------------------------------------------------------------------
// Containment preparation
// ---------------------------------------------------------------------------

function prepareContainment(pieces: TileData['roadSurfaces'] | null | undefined): ContainmentSets {
  return {
    groundAsphalt: prepareDrivablePieces(pieces, false, ASPHALT_ONLY),
    bridgeAsphalt: prepareDrivablePieces(pieces, true, ASPHALT_ONLY),
    groundCrossing: prepareDrivablePieces(pieces, false, PAVED_MATERIALS),
  };
}

/**
 * Prepare the tile's drivable pieces of one bridge flag and material set.
 * Junction asphalt faces (`junction: true`) are deliberately excluded from
 * containment — paint can never be *contained* by a junction face — and they
 * are also used as hard chunk-aware paint blockers (see prepareJunctionSurfaces).
 */
function prepareDrivablePieces(
  pieces: TileData['roadSurfaces'] | null | undefined,
  bridge: boolean,
  materials: readonly RoadMaterial[],
): PreparedPiece[] {
  const out: PreparedPiece[] = [];
  if (!Array.isArray(pieces)) return out;
  for (const piece of pieces) {
    if (!piece || piece.kind !== 'drivable') continue;
    if (piece.junction === true) continue;
    if ((piece.bridge === true) !== bridge) continue;
    if (!materials.includes(piece.material ?? 'asphalt')) continue;
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

// ---------------------------------------------------------------------------
// Junction preparation
// ---------------------------------------------------------------------------

function prepareJunctions(
  junctions: JunctionFeature[] | null | undefined,
  surfaces: TileData['roadSurfaces'] | null | undefined,
): JunctionContext {
  const context: JunctionContext = {
    infos: [],
    faces: [],
    surfaces: prepareJunctionSurfaces(surfaces),
    legacy: [],
    approachStopLines: [],
  };
  if (!Array.isArray(junctions)) return context;
  const seenBars = new Set<string>();
  for (const junction of junctions) {
    if (!junction) continue;
    if (!Number.isFinite(junction.x) || !Number.isFinite(junction.y)) continue;
    const radiusOk = Number.isFinite(junction.radius) && junction.radius >= 0;
    const hasPolygon = Array.isArray(junction.polygon) && junction.polygon.length > 0;
    if (!radiusOk && !hasPolygon) continue;
    const face = prepareJunctionFace(junction);
    context.infos.push({ feature: junction, face });
    if (face) {
      context.faces.push(face);
    } else if (radiusOk) {
      context.legacy.push(junction);
    }
    const edges = junction.approachEdges;
    if (Array.isArray(edges)) {
      for (const edge of edges) {
        const stopLine = edge?.stopLine;
        if (!stopLine) continue;
        if (
          !Number.isFinite(stopLine.x) ||
          !Number.isFinite(stopLine.y) ||
          !Number.isFinite(stopLine.angle) ||
          !Number.isFinite(stopLine.width) ||
          !(stopLine.width > 0.5)
        ) {
          continue;
        }
        // Junction records are duplicated into every tile they touch; the
        // ownership check at emit time dedupes across tiles, this dedupes a
        // duplicated record inside one tile payload.
        const key = `${stopLine.x.toFixed(2)},${stopLine.y.toFixed(2)},${stopLine.angle.toFixed(3)},${stopLine.width.toFixed(2)}`;
        if (seenBars.has(key)) continue;
        seenBars.add(key);
        context.approachStopLines.push({
          x: stopLine.x,
          y: stopLine.y,
          angle: stopLine.angle,
          width: stopLine.width,
          ownerX: junction.x,
          ownerY: junction.y,
        });
      }
    }
  }
  return context;
}

/**
 * Prepare the `junction: true` asphalt surface pieces as paint blockers.
 * These are a hard exclusion regardless of junction records: the pipeline can
 * drop a record's face polygon (<1 m²) while the asphalt face sliver remains.
 */
function prepareJunctionSurfaces(
  pieces: TileData['roadSurfaces'] | null | undefined,
): JunctionFace[] {
  const out: JunctionFace[] = [];
  if (!Array.isArray(pieces)) return out;
  for (const piece of pieces) {
    if (!piece || piece.junction !== true) continue;
    if (!Array.isArray(piece.polygon)) continue;
    try {
      const prepared = prepareFlatPolygon(piece.polygon, { minArea: 0.01 });
      if (!prepared) continue;
      out.push({
        prepared,
        bbox: ringBounds(prepared.exterior),
        rings: [prepared.exterior, ...prepared.holes],
      });
    } catch {
      // Ignore: a broken face simply provides no exclusion.
    }
  }
  return out;
}

/**
 * Prepare the authoritative asphalt face polygon of a 0.3.0 junction.
 *
 * Payload 0.3.0 junctions all carry a face polygon; a `fallback: true` face is
 * the union-of-mouth rectangle approximation, which is still a usable clip
 * polygon (not a circle). Only a missing/invalid polygon falls back to the
 * legacy clearance radius.
 */
function prepareJunctionFace(junction: JunctionFeature): JunctionFace | null {
  const polygon = junction.polygon;
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  try {
    const prepared = prepareFlatPolygon(polygon, { minArea: 0.01 });
    if (!prepared) return null;
    return {
      prepared,
      bbox: ringBounds(prepared.exterior),
      rings: [prepared.exterior, ...prepared.holes],
    };
  } catch {
    return null;
  }
}

/**
 * Precompute crossing clearance circles for lane-paint suppression. Any
 * crossing record with a finite position and angle participates; the centre
 * clearance is `max(2.5, span/2 + 1) + 1.5` metres (half a centre dash) so the
 * dash body cannot touch the crossing paint either.
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
    const radius =
      Math.max(CROSSING_CLEARANCE_MIN_M, span / 2 + CROSSING_CLEARANCE_PAD_M) +
      CENTRE_DASH_LENGTH_M / 2;
    out.push({ x: crossing.x, y: crossing.y, angle: crossing.angle, radius });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lane-marking layout
// ---------------------------------------------------------------------------

/**
 * Derive the complete lane-marking layout for one normalized road piece.
 *
 * Slip links (`link: true`), service aisles (`class: 'service'`) and roundabout
 * rings get no centre line or lane dividers (links/service get no lane paint at
 * all; roundabouts keep their edge lines).
 *
 * Two-way pieces use the tagged `lanesForward`/`lanesBackward` counts when
 * present: the centre line is offset from the geometric centre by
 * `(f - b) / 2 * laneWidth`, lane dividers are placed at one lane pitch on each
 * side, and the centre type follows the width thresholds (double solid from
 * 12.5 m, dashed from 5.5 m). Tagged lane counts are never clamped down to a
 * width-derived number; the only guards are an absolute cap of 8 lanes per
 * direction and `floor(width / 2.2) + 1`, which stops nonsense tags from
 * painting across a narrow road. One-way pieces use `lanes` for the divider
 * count. Merged corridors stay two-way and split from the direction tags when
 * present, otherwise symmetrically.
 */
export function laneMarkingLayout(piece: {
  width: number;
  class: RoadClass;
  oneway?: boolean;
  lanes?: number;
  lanesForward?: number;
  lanesBackward?: number;
  merged?: boolean;
  link?: boolean;
  roundabout?: boolean;
}): PaintLine[] {
  const width = Number.isFinite(piece.width) ? piece.width : 0;
  if (!(width > 0)) return [];
  // Slip roads and service aisles are anonymous connectors with no lane paint.
  if (piece.link === true || piece.class === 'service') return [];
  const laneCap = maxLaneCountForWidth(width);
  const roundabout = piece.roundabout === true;
  const lines: PaintLine[] = [];
  const oneWay = piece.merged !== true && piece.oneway === true;

  if (oneWay) {
    if (roundabout) {
      // Roundabout rings keep their edge lines only.
    } else {
      // One carriageway direction: lanes divided evenly across the full width.
      const inferred = Math.max(1, Math.round((width - 0.8) / LANE_WIDTH_M));
      const laneCount = clampLaneCount(piece.lanes ?? inferred, 1, laneCap);
      for (let lane = 1; lane < laneCount; lane++) {
        lines.push(dividerLine(-width / 2 + (lane * width) / laneCount));
      }
    }
  } else {
    let forward: number;
    let backward: number;
    const fTag = finiteLaneCount(piece.lanesForward);
    const bTag = finiteLaneCount(piece.lanesBackward);
    const totalTag = finiteLaneCount(piece.lanes);
    if (fTag !== null || bTag !== null) {
      if (fTag !== null && bTag !== null) {
        forward = fTag;
        backward = bTag;
      } else if (fTag !== null) {
        forward = fTag;
        backward = totalTag !== null ? Math.max(1, totalTag - fTag) : forward;
      } else {
        backward = bTag as number;
        forward = totalTag !== null ? Math.max(1, totalTag - backward) : backward;
      }
    } else if (piece.merged === true) {
      // Merged corridors are symmetric unless direction tags say otherwise.
      const total = totalTag ?? Math.max(2, Math.round(width / LANE_WIDTH_M));
      const perDir = Math.max(1, Math.round(total / 2));
      forward = perDir;
      backward = perDir;
    } else if (totalTag !== null) {
      forward = Math.max(1, Math.round(totalTag / 2));
      backward = Math.max(1, totalTag - forward);
    } else {
      // Pre-0.3.0 payloads: infer one lane for each direction from the width.
      const perDir = Math.max(1, Math.floor((width / 2 - 0.4) / LANE_WIDTH_M));
      forward = perDir;
      backward = perDir;
    }
    forward = clampLaneCount(forward, 1, laneCap);
    backward = clampLaneCount(backward, 1, laneCap);

    if (roundabout) {
      // Roundabout rings get edge lines only.
    } else {
      const laneWidth = clampNumber(
        (width - LANE_TOTAL_MARGIN_M) / Math.max(1, forward + backward),
        LANE_WIDTH_MIN_M,
        LANE_WIDTH_MAX_M,
      );
      const centreOffset = ((forward - backward) / 2) * laneWidth;

      if (width >= DOUBLE_SOLID_MIN_WIDTH_M) {
        lines.push(solidLine('centre', centreOffset + DOUBLE_SOLID_OFFSET_M, DOUBLE_SOLID_WIDTH_M));
        lines.push(solidLine('centre', centreOffset - DOUBLE_SOLID_OFFSET_M, DOUBLE_SOLID_WIDTH_M));
      } else if (width >= TWO_WAY_CENTRE_MIN_WIDTH_M) {
        lines.push(centreDashLine(centreOffset));
      }
      // Forward lanes are on the -n side (right of travel); backward on +n.
      for (let lane = 1; lane < forward; lane++) {
        lines.push(dividerLine(centreOffset - lane * laneWidth));
      }
      for (let lane = 1; lane < backward; lane++) {
        lines.push(dividerLine(centreOffset + lane * laneWidth));
      }
    }
  }

  if (EDGE_LINE_CLASSES.has(piece.class) && width >= EDGE_LINE_MIN_WIDTH_M) {
    const offset = width / 2 - EDGE_LINE_INSET_M;
    lines.push(solidLine('edge', offset, EDGE_LINE_WIDTH_M));
    lines.push(solidLine('edge', -offset, EDGE_LINE_WIDTH_M));
  }

  return lines;
}

function dividerLine(offset: number): PaintLine {
  return {
    kind: 'divider',
    offset,
    dashed: true,
    length: LANE_DASH_LENGTH_M,
    spacing: LANE_DASH_SPACING_M,
    width: LANE_DASH_WIDTH_M,
  };
}

function centreDashLine(offset: number): PaintLine {
  return {
    kind: 'centre',
    offset,
    dashed: true,
    length: CENTRE_DASH_LENGTH_M,
    spacing: CENTRE_DASH_SPACING_M,
    width: CENTRE_DASH_WIDTH_M,
  };
}

function solidLine(kind: PaintLine['kind'], offset: number, width: number): PaintLine {
  return {
    kind,
    offset,
    dashed: false,
    length: SOLID_CHUNK_M,
    spacing: SOLID_CHUNK_M,
    width,
  };
}

/** Absolute lane-count guard for one direction of a piece of this width. */
function maxLaneCountForWidth(width: number): number {
  // +1e-9 absorbs float division noise (6.6 / 2.2 = 2.9999999999999996).
  return Math.min(ABS_MAX_LANES, Math.max(1, Math.floor(width / MIN_LANE_SPACE_M + 1e-9) + 1));
}

/** Round a lane count and clamp it into `[min, max]`; NaN falls back to min. */
function clampLaneCount(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

/** Finite non-negative lane count or null. */
function finiteLaneCount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// Lane paint emission
// ---------------------------------------------------------------------------

function emitLanePaint(
  sink: GeometrySink,
  piece: RoadNetworkPiece,
  bounds: Bounds4,
  junctions: JunctionContext,
  crossings: readonly CrossingClearance[],
  containment: ContainmentSets,
  stats: RoadNetworkStats,
): void {
  const points = centerlinePoints(piece.centerline);
  if (points.length < 2) {
    stats.skippedPieces++;
    return;
  }
  const total = pathLength(points);
  if (!(total > 1.0)) return;
  const lines = laneMarkingLayout({
    width: piece.width,
    class: piece.class,
    oneway: piece.oneway,
    lanes: piece.lanes,
    lanesForward: piece.lanesForward,
    lanesBackward: piece.lanesBackward,
    merged: piece.merged,
    link: piece.link,
    roundabout: piece.roundabout,
  });
  if (lines.length === 0) return;

  const bridge = piece.bridge === true;
  const asphalt = bridge ? containment.bridgeAsphalt : containment.groundAsphalt;
  const paintY = ENV_LAYER_Y.markings + (bridge ? BRIDGE_RAISE_M : 0);
  const offset = Number.isFinite(piece.centerlineOffset) ? piece.centerlineOffset : 0;
  let emitted = 0;
  let dashed = 0;
  for (const line of lines) {
    if (stats.markingTriangles + 2 > MAX_MARKING_TRIANGLES_PER_TILE) {
      stats.capped = true;
      break;
    }
    const count = line.dashed
      ? emitDashedLine(
          sink,
          points,
          total,
          offset,
          line,
          bounds,
          junctions,
          crossings,
          asphalt,
          paintY,
          stats,
        )
      : emitSolidLine(
          sink,
          points,
          total,
          offset,
          line,
          bounds,
          junctions,
          crossings,
          asphalt,
          paintY,
          stats,
        );
    emitted += count;
    if (line.dashed) dashed += count;
  }
  if (emitted > 0) stats.paintedPieces++;
  if (dashed > 0) stats.dashedPieces++;
}

/** Emit a dashed paint line (centre dashes and lane dividers). */
function emitDashedLine(
  sink: GeometrySink,
  points: readonly Point2[],
  total: number,
  offset: number,
  line: PaintLine,
  bounds: Bounds4,
  junctions: JunctionContext,
  crossings: readonly CrossingClearance[],
  asphalt: readonly PreparedPiece[],
  paintY: number,
  stats: RoadNetworkStats,
): number {
  const centres = periodicCentres(total, offset, line.spacing, line.length);
  let emitted = 0;
  for (const station of centres) {
    if (stats.markingTriangles + 2 > MAX_MARKING_TRIANGLES_PER_TILE) {
      stats.capped = true;
      break;
    }
    const at = stationAt(points, station);
    if (!at) continue;
    const centre = offsetPoint(at, line.offset);
    if (!insideBounds(centre[0], centre[1], bounds)) {
      stats.boundsSkipped++;
      continue;
    }
    if (insideAnyJunctionFace(centre[0], centre[1], junctions.faces, line.length / 2)) {
      stats.junctionFaceSkipped++;
      continue;
    }
    if (insideAnyJunctionFace(centre[0], centre[1], junctions.surfaces, line.length / 2)) {
      stats.junctionSurfaceSkipped++;
      continue;
    }
    // Legacy 0.2.0 junction: the whole dash must stay clear.
    if (
      insideJunctionClearance(centre[0], centre[1], junctions.legacy, line.length / 2)
    ) {
      stats.junctionSkipped++;
      continue;
    }
    if (insideCrossingClearance(centre[0], centre[1], at, crossings)) {
      stats.crossingClearanceSkipped++;
      continue;
    }
    const corners = quadCorners(
      centre[0],
      centre[1],
      at.ux,
      at.uy,
      -at.uy,
      at.ux,
      line.length / 2,
      line.width / 2,
    );
    if (!cornersInsideAnyPiece(corners, asphalt, bounds, true)) {
      stats.containmentSkipped++;
      continue;
    }
    if (
      sink.addFlatQuad(corners[0], corners[1], corners[2], corners[3], paintY, MARKING_COLOR)
    ) {
      stats.dashes++;
      stats.markingTriangles += 2;
      emitted++;
    }
  }
  return emitted;
}

/** Emit a solid paint line as short chunks on the global 2 m grid. */
function emitSolidLine(
  sink: GeometrySink,
  points: readonly Point2[],
  total: number,
  offset: number,
  line: PaintLine,
  bounds: Bounds4,
  junctions: JunctionContext,
  crossings: readonly CrossingClearance[],
  asphalt: readonly PreparedPiece[],
  paintY: number,
  stats: RoadNetworkStats,
): number {
  const spans = solidChunkSpans(total, offset, line.length);
  let emitted = 0;
  for (const span of spans) {
    if (stats.markingTriangles + 2 > MAX_MARKING_TRIANGLES_PER_TILE) {
      stats.capped = true;
      break;
    }
    const at = stationAt(points, span.centre);
    if (!at) continue;
    const centre = offsetPoint(at, line.offset);
    if (!insideBounds(centre[0], centre[1], bounds)) {
      stats.boundsSkipped++;
      continue;
    }
    if (
      insideAnyJunctionFace(
        centre[0],
        centre[1],
        junctions.faces,
        (span.s1 - span.s0) / 2,
      )
    ) {
      stats.junctionFaceSkipped++;
      continue;
    }
    if (
      insideAnyJunctionFace(
        centre[0],
        centre[1],
        junctions.surfaces,
        (span.s1 - span.s0) / 2,
      )
    ) {
      stats.junctionSurfaceSkipped++;
      continue;
    }
    if (insideJunctionClearance(centre[0], centre[1], junctions.legacy, 0)) {
      stats.junctionSkipped++;
      continue;
    }
    if (insideCrossingClearance(centre[0], centre[1], at, crossings)) {
      stats.crossingClearanceSkipped++;
      continue;
    }
    const corners = quadCorners(
      centre[0],
      centre[1],
      at.ux,
      at.uy,
      -at.uy,
      at.ux,
      (span.s1 - span.s0) / 2,
      line.width / 2,
    );
    if (!cornersInsideAnyPiece(corners, asphalt, bounds, true)) {
      stats.containmentSkipped++;
      continue;
    }
    if (
      sink.addFlatQuad(corners[0], corners[1], corners[2], corners[3], paintY, MARKING_COLOR)
    ) {
      stats.solidChunks++;
      stats.markingTriangles += 2;
      emitted++;
    }
  }
  return emitted;
}

/**
 * Centres of `length`-long dashed elements with period `spacing`, anchored to
 * the global arc length (`offset + station`). An element occupies the first
 * `length` metres of each global period; the returned stations are its centres.
 */
function periodicCentres(
  total: number,
  offset: number,
  spacing: number,
  length: number,
): number[] {
  const out: number[] = [];
  if (!(spacing > 0) || !(length > 0) || !(total > 0) || !Number.isFinite(total)) return out;
  const phase = Number.isFinite(offset) ? offset : 0;
  const half = length / 2;
  const firstK = Math.ceil((phase - half) / spacing);
  const lastK = Math.floor((total + phase - half) / spacing);
  for (let k = firstK; k <= lastK; k++) {
    if (out.length >= MAX_ELEMENTS_PER_LINE) break;
    const station = k * spacing + half - phase;
    if (!Number.isFinite(station)) continue;
    // Numeric tolerance at the piece ends; the phase error introduced by the
    // clamp is < 1e-9 m and cannot be seen.
    if (station < -1e-9 || station > total + 1e-9) continue;
    out.push(station < 0 ? 0 : station > total ? total : station);
  }
  return out;
}

interface SolidSpan {
  s0: number;
  s1: number;
  centre: number;
}

/**
 * Solid-line chunks on the global `chunk` grid. Unlike dashes, chunks are
 * contiguous (no gaps); the first/last chunk of a piece is clamped to the piece
 * ends so solid lines meet at OSM way joins without a gap.
 */
function solidChunkSpans(total: number, offset: number, chunk: number): SolidSpan[] {
  const out: SolidSpan[] = [];
  if (!(chunk > 0) || !(total > 0) || !Number.isFinite(total)) return out;
  const phase = Number.isFinite(offset) ? offset : 0;
  const firstK = Math.floor(phase / chunk);
  const lastK = Math.floor((total + phase) / chunk);
  for (let k = firstK; k <= lastK; k++) {
    if (out.length >= MAX_SOLID_CHUNKS_PER_LINE) break;
    const a = k * chunk - phase;
    const b = a + chunk;
    const s0 = Math.max(0, a);
    const s1 = Math.min(total, b);
    if (!(s1 - s0 > MIN_SOLID_CHUNK_M)) continue;
    out.push({ s0, s1, centre: (s0 + s1) / 2 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Junction approach stop lines
// ---------------------------------------------------------------------------

/**
 * Paint the authoritative stop bars supplied by junction approach edges
 * (payload 0.3.0). The bar's `angle` is the approach travel direction (towards
 * the junction), so the bar runs across it. The tile whose bounds contain the
 * **junction centre** paints all of that junction's bars: junction records are
 * duplicated into every tile they touch, so this keeps the bars exactly once
 * per junction while still allowing a bar at the face boundary to overhang a
 * tile border.
 */
function emitJunctionStopLines(
  sink: GeometrySink,
  junctions: JunctionContext,
  bounds: Bounds4,
  stats: RoadNetworkStats,
): void {
  for (const bar of junctions.approachStopLines) {
    if (stats.markingTriangles + 2 > MAX_MARKING_TRIANGLES_PER_TILE) {
      stats.capped = true;
      break;
    }
    if (!insideBounds(bar.ownerX, bar.ownerY, bounds)) continue;
    const ux = Math.cos(bar.angle);
    const uy = Math.sin(bar.angle);
    const nx = -uy;
    const ny = ux;
    const halfWidth = Math.max(0.1, bar.width / 2 - STOP_LINE_EDGE_INSET_M);
    const corners = quadCorners(bar.x, bar.y, nx, ny, -ny, nx, halfWidth, STOP_LINE_WIDTH_M / 2);
    if (
      sink.addFlatQuad(
        corners[0],
        corners[1],
        corners[2],
        corners[3],
        CROSSING_STOP_LINE_Y,
        MARKING_COLOR_DIM,
      )
    ) {
      stats.approachStopLines++;
      stats.markingTriangles += 2;
    }
  }
}

// ---------------------------------------------------------------------------
// Crossing paint
// ---------------------------------------------------------------------------

function emitCrossing(
  sink: GeometrySink,
  crossing: CrossingFeature | null | undefined,
  junctions: JunctionContext,
  containment: ContainmentSets,
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

  const pieces = containment.groundCrossing;
  if (crossing.kind === 'zebra') {
    emitZebraBars(
      sink,
      crossing.x,
      crossing.y,
      ux,
      uy,
      nx,
      ny,
      width,
      span,
      pieces,
      junctions.faces,
      junctions.surfaces,
      stats,
    );
  }
  emitLegacyStopLines(
    sink,
    crossing,
    ux,
    uy,
    nx,
    ny,
    width,
    span,
    junctions,
    pieces,
    stats,
  );
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
  pieces: readonly PreparedPiece[],
  faces: readonly JunctionFace[],
  surfaces: readonly JunctionFace[],
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
    // Junction faces own their asphalt: no zebra paint may sit on the face or
    // reach it with the bar's far half (chunk-aware clearance).
    if (insideAnyJunctionFace(cx, cy, faces, span / 2)) {
      stats.zebraJunctionSkipped++;
      continue;
    }
    // Junction asphalt surface pieces are a hard exclusion even when no face
    // record polygon survived for them.
    if (insideAnyJunctionFace(cx, cy, surfaces, span / 2)) {
      stats.junctionSurfaceSkipped++;
      continue;
    }
    const corners = quadCorners(cx, cy, ux, uy, nx, ny, span / 2, ZEBRA_BAR_WIDTH_M / 2);
    if (!cornersInsideSameFlagPieces(corners, pieces)) {
      stats.crossingContainmentSkipped++;
      continue;
    }
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
 * Legacy crossing-based stop line(s), `span/2 + 0.7 m` before the crossing.
 *
 * They are only painted when the junction does not already provide an explicit
 * approach stop bar for this road (payload 0.3.0), and they are clipped out of
 * junction faces/circles. The line is inset from the kerbs so its corners stay
 * on the drivable asphalt.
 */
function emitLegacyStopLines(
  sink: GeometrySink,
  crossing: CrossingFeature,
  ux: number,
  uy: number,
  nx: number,
  ny: number,
  width: number,
  span: number,
  junctions: JunctionContext,
  pieces: readonly PreparedPiece[],
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
    // Long axis across the carriageway (inset from the kerbs), 0.5 m thick.
    const halfWidth = Math.max(0.1, width / 2 - STOP_LINE_EDGE_INSET_M);
    if (hasExplicitApproachStopLine(cx, cy, crossing.angle, junctions)) {
      stats.legacyStopLinesSuppressed++;
      continue;
    }
    // Chunk-aware face clearance: the bar's far (across-road) half must not
    // reach the junction face either.
    if (insideAnyJunctionFace(cx, cy, junctions.faces, halfWidth)) {
      stats.stopLineJunctionSkipped++;
      continue;
    }
    if (insideAnyJunctionFace(cx, cy, junctions.surfaces, halfWidth)) {
      stats.junctionSurfaceSkipped++;
      continue;
    }
    if (insideJunctionClearance(cx, cy, junctions.legacy, 0)) {
      stats.stopLineJunctionSkipped++;
      continue;
    }
    const corners = quadCorners(cx, cy, nx, ny, -ny, nx, halfWidth, STOP_LINE_WIDTH_M / 2);
    if (!cornersInsideSameFlagPieces(corners, pieces)) {
      stats.crossingContainmentSkipped++;
      continue;
    }
    if (
      sink.addFlatQuad(
        corners[0],
        corners[1],
        corners[2],
        corners[3],
        CROSSING_STOP_LINE_Y,
        MARKING_COLOR_DIM,
      )
    ) {
      stats.stopLines++;
      stats.markingTriangles += 2;
    }
  }
}

/**
 * True when a junction's approach edges supply a stop bar for this road near the
 * legacy stop-line position. The bar is the authoritative paint for that
 * direction; painting both would double-stroke the same approach.
 */
function hasExplicitApproachStopLine(
  x: number,
  y: number,
  roadAngle: number,
  junctions: JunctionContext,
): boolean {
  const matchRadiusSq = APPROACH_STOP_LINE_MATCH_M * APPROACH_STOP_LINE_MATCH_M;
  for (const info of junctions.infos) {
    const edges = info.feature.approachEdges;
    if (!Array.isArray(edges) || edges.length === 0) continue;
    for (const edge of edges) {
      const stopLine = edge?.stopLine;
      if (!stopLine || !Number.isFinite(edge.angle)) continue;
      const dx = stopLine.x - x;
      const dy = stopLine.y - y;
      if (dx * dx + dy * dy > matchRadiusSq) continue;
      // The approach direction is parallel to the road line (mod 180°).
      let delta = (edge.angle - roadAngle) % Math.PI;
      if (delta < 0) delta += Math.PI;
      if (delta > Math.PI - delta) delta = Math.PI - delta;
      if (delta <= APPROACH_STOP_LINE_ANGLE_RAD) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tram rails
// ---------------------------------------------------------------------------

/**
 * Emit ballast + two rail heads for a `kind === 'rail'` network piece.
 *
 * The piece centreline is per-tile clipped with a ~4 m overhang (like road
 * centrelines), so the strip geometry is clipped to the tile bounds: each tile
 * renders its own half exactly once, neighbouring tiles meet at the border and
 * no junction/crossing clearance is applied (rails must run through both).
 */
function emitRailPiece(
  sink: GeometrySink,
  piece: RoadNetworkPiece,
  bounds: Bounds4,
  stats: RoadNetworkStats,
): void {
  const points = centerlinePoints(piece.centerline);
  if (points.length < 2) {
    stats.skippedPieces++;
    return;
  }
  const total = pathLength(points);
  if (!(total > 0.5)) return;
  const pieceWidth = Number.isFinite(piece.width) ? piece.width : 0;
  const ballastWidth = Math.max(pieceWidth, RAIL_BALLAST_MIN_WIDTH_M);
  const bridge = piece.bridge === true;
  const raise = bridge ? BRIDGE_RAISE_M : 0;
  const ballastY = ENV_LAYER_Y.railBallast + raise;
  const headY = ENV_LAYER_Y.railTrack + raise;
  const offset = Number.isFinite(piece.centerlineOffset) ? piece.centerlineOffset : 0;

  const stations = railStations(total, offset);
  let emittedSegments = 0;
  let triangles = 0;
  for (let index = 0; index < stations.length; index++) {
    if (index === 0) continue;
    if (emittedSegments >= MAX_RAIL_SEGMENTS_PER_PIECE) break;
    const start = stationAt(points, stations[index - 1]);
    const end = stationAt(points, stations[index]);
    if (!start || !end) continue;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (!(length > 1e-6)) continue;
    const ux = dx / length;
    const uy = dy / length;
    const nx = -uy;
    const ny = ux;
    const ballast = railStripQuad(start, end, nx, ny, 0, ballastWidth / 2);
    const headLeft = railStripQuad(
      start,
      end,
      nx,
      ny,
      RAIL_HEAD_OFFSET_M,
      RAIL_LINE_WIDTH_M / 2,
    );
    const headRight = railStripQuad(
      start,
      end,
      nx,
      ny,
      -RAIL_HEAD_OFFSET_M,
      RAIL_LINE_WIDTH_M / 2,
    );
    const ballastTriangles = emitClippedQuad(sink, ballast, ballastY, RAIL_BALLAST_COLOR, bounds);
    const leftTriangles = emitClippedQuad(sink, headLeft, headY, RAIL_HEAD_COLOR, bounds);
    const rightTriangles = emitClippedQuad(sink, headRight, headY, RAIL_HEAD_COLOR, bounds);
    const added = ballastTriangles + leftTriangles + rightTriangles;
    if (added > 0) {
      emittedSegments++;
      triangles += added;
    }
  }
  if (emittedSegments > 0) {
    stats.railPieces++;
    stats.railSegments += emittedSegments;
    stats.railTriangles += triangles;
  }
}

/**
 * Sample stations along a rail piece: the piece ends plus a global 3 m grid
 * (`offset + station` multiples), so the two tiles that share a rail centreline
 * generate identical strips near their common border and clip perfectly.
 */
function railStations(total: number, offset: number): number[] {
  const stations: number[] = [0];
  const step = RAIL_SAMPLE_STEP_M;
  const phase = Number.isFinite(offset) ? offset : 0;
  const firstK = Math.ceil(phase / step);
  const lastK = Math.floor((total + phase) / step);
  for (let k = firstK; k <= lastK; k++) {
    if (stations.length >= MAX_RAIL_SEGMENTS_PER_PIECE) break;
    const station = k * step - phase;
    if (station > 1e-6 && station < total - 1e-6) stations.push(station);
  }
  stations.push(total);
  stations.sort((a, b) => a - b);
  // Drop duplicates introduced by the piece ends coinciding with the grid.
  const unique: number[] = [];
  for (const station of stations) {
    if (unique.length === 0 || station - unique[unique.length - 1] > 1e-6) unique.push(station);
  }
  return unique;
}

/** Quad strip along one path segment: centreline offset `lateral`, half width. */
function railStripQuad(
  start: PathStation,
  end: PathStation,
  nx: number,
  ny: number,
  lateral: number,
  halfWidth: number,
): [Point2, Point2, Point2, Point2] {
  return [
    [start.x + nx * (lateral - halfWidth), start.y + ny * (lateral - halfWidth)],
    [end.x + nx * (lateral - halfWidth), end.y + ny * (lateral - halfWidth)],
    [end.x + nx * (lateral + halfWidth), end.y + ny * (lateral + halfWidth)],
    [start.x + nx * (lateral + halfWidth), start.y + ny * (lateral + halfWidth)],
  ];
}

/**
 * Clip a quad to the tile bounds and emit it as flat triangles. Returns the
 * number of triangles added (0 when the quad lies fully outside the tile).
 */
function emitClippedQuad(
  sink: GeometrySink,
  corners: Point2[],
  y: number,
  color: string,
  bounds: Bounds4,
): number {
  const polygon = clipPolygonToBounds(corners, bounds);
  if (polygon.length < 3) return 0;
  let triangles = 0;
  for (let index = 1; index + 1 < polygon.length; index++) {
    const a = polygon[0];
    const b = polygon[index];
    const c = polygon[index + 1];
    if (sink.addFlatTriangle(a[0], a[1], b[0], b[1], c[0], c[1], y, color)) triangles++;
  }
  return triangles;
}

/** Sutherland–Hodgman clip of a convex polygon to an axis-aligned rectangle. */
function clipPolygonToBounds(polygon: readonly Point2[], bounds: Bounds4): Point2[] {
  const [minX, minY, maxX, maxY] = bounds;
  let out: Point2[] = polygon.map((point) => [point[0], point[1]] as Point2);
  out = clipPolygon(out, (p) => p[0] >= minX - 1e-9, (a, b) => intersectVertical(a, b, minX));
  if (out.length === 0) return out;
  out = clipPolygon(out, (p) => p[0] <= maxX + 1e-9, (a, b) => intersectVertical(a, b, maxX));
  if (out.length === 0) return out;
  out = clipPolygon(out, (p) => p[1] >= minY - 1e-9, (a, b) => intersectHorizontal(a, b, minY));
  if (out.length === 0) return out;
  out = clipPolygon(out, (p) => p[1] <= maxY + 1e-9, (a, b) => intersectHorizontal(a, b, maxY));
  return out;
}

function clipPolygon(
  polygon: readonly Point2[],
  inside: (point: Point2) => boolean,
  intersect: (a: Point2, b: Point2) => Point2,
): Point2[] {
  if (polygon.length === 0) return [];
  const out: Point2[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside) {
      if (!previousInside) out.push(intersect(previous, current));
      out.push(current);
    } else if (previousInside) {
      out.push(intersect(previous, current));
    }
  }
  return out;
}

function intersectVertical(a: Point2, b: Point2, x: number): Point2 {
  const dx = b[0] - a[0];
  if (Math.abs(dx) < 1e-12) return [x, a[1]];
  const t = (x - a[0]) / dx;
  return [x, a[1] + (b[1] - a[1]) * t];
}

function intersectHorizontal(a: Point2, b: Point2, y: number): Point2 {
  const dy = b[1] - a[1];
  if (Math.abs(dy) < 1e-12) return [a[0], y];
  const t = (y - a[1]) / dy;
  return [a[0] + (b[0] - a[0]) * t, y];
}

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

/** Offset a station sideways: positive = left of the travel direction. */
function offsetPoint(station: PathStation, offset: number): Point2 {
  // Normal is the tangent rotated +90°: n = (-uy, ux).
  return [station.x - station.uy * offset, station.y + station.ux * offset];
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

/** True when a paint corner lies inside this tile (small margin for rounding). */
function cornerBelongsToTile(x: number, y: number, bounds: Bounds4): boolean {
  return (
    x >= bounds[0] - CORNER_TILE_MARGIN_M &&
    x <= bounds[2] + CORNER_TILE_MARGIN_M &&
    y >= bounds[1] - CORNER_TILE_MARGIN_M &&
    y <= bounds[3] + CORNER_TILE_MARGIN_M
  );
}

/**
 * True when (x, y) is inside a 0.3.0 junction face buffered by
 * `JUNCTION_FACE_CLEARANCE_M + extraClearance`. Callers pass half the paint
 * element's length as `extraClearance`, so a 2 m solid chunk or 3 m dash whose
 * centre sits just outside the buffer still cannot reach the face with its far
 * half. The bbox prefilter runs first; points inside the polygon are accepted
 * directly, points outside are tested against the boundary distance (holes
 * included).
 */
function insideAnyJunctionFace(
  x: number,
  y: number,
  faces: readonly JunctionFace[],
  extraClearance = 0,
): boolean {
  const clearance = JUNCTION_FACE_CLEARANCE_M + Math.max(0, extraClearance);
  const clearanceSq = clearance * clearance;
  for (const face of faces) {
    const [minX, minY, maxX, maxY] = face.bbox;
    if (x < minX - clearance || x > maxX + clearance) continue;
    if (y < minY - clearance || y > maxY + clearance) continue;
    if (pointInPreparedPolygon(face.prepared, x, y)) return true;
    for (const ring of face.rings) {
      for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
        const a = ring[previous];
        const b = ring[index];
        if (distanceToSegmentSq(x, y, a[0], a[1], b[0], b[1]) <= clearanceSq) return true;
      }
    }
  }
  return false;
}

/** Squared distance from a point to an axis segment (0..1 clamped projection). */
function distanceToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * clamped;
  const qy = ay + dy * clamped;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

/**
 * True when (x, y) is inside a legacy junction plus `extra` metres (the paint
 * half length for dashes, 0 for solid chunks and stop lines).
 */
function insideJunctionClearance(
  x: number,
  y: number,
  junctions: readonly JunctionFeature[],
  extra: number,
): boolean {
  const clearance = JUNCTION_CLEARANCE_M + extra;
  for (const junction of junctions) {
    const dx = x - junction.x;
    const dy = y - junction.y;
    const radius = junction.radius + clearance;
    if (dx * dx + dy * dy < radius * radius) return true;
  }
  return false;
}

/** Dashes keep clear of a crossing of this road (same direction, +/-30°). */
function insideCrossingClearance(
  x: number,
  y: number,
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
    const dx = x - crossing.x;
    const dy = y - crossing.y;
    if (dx * dx + dy * dy <= crossing.radius * crossing.radius) return true;
  }
  return false;
}

/**
 * True when every paint corner that belongs to this tile lies inside one of the
 * given drivable pieces. Corners overhanging into the neighbouring tile are
 * ignored (`skipOutsideTile`): their asphalt lives there, and testing them
 * against this tile's clipped surface would drop paint that straddles a tile
 * border. Ownership of the paint element itself is decided by its centre.
 */
function cornersInsideAnyPiece(
  corners: readonly Point2[],
  pieces: readonly PreparedPiece[],
  bounds: Bounds4,
  skipOutsideTile: boolean,
): boolean {
  if (pieces.length === 0) return false;
  for (const piece of pieces) {
    let allInside = true;
    for (const corner of corners) {
      if (skipOutsideTile && !cornerBelongsToTile(corner[0], corner[1], bounds)) continue;
      if (!insidePreparedPiece(piece, corner[0], corner[1])) {
        allInside = false;
        break;
      }
    }
    if (allInside) return true;
  }
  return false;
}

/**
 * True when every corner lies inside *some* drivable piece and all of those
 * pieces share one bridge flag (crossing paint must not mix ground and raised
 * deck heights). Corners may fall in different material zones (asphalt/stone),
 * which is why this is not restricted to a single piece.
 */
function cornersInsideSameFlagPieces(
  corners: readonly Point2[],
  pieces: readonly PreparedPiece[],
): boolean {
  if (pieces.length === 0) return false;
  for (const corner of corners) {
    let found = false;
    for (const piece of pieces) {
      if (insidePreparedPiece(piece, corner[0], corner[1])) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function insidePreparedPiece(piece: PreparedPiece, x: number, y: number): boolean {
  const [minX, minY, maxX, maxY] = piece.bbox;
  if (x < minX - 1e-6 || x > maxX + 1e-6 || y < minY - 1e-6 || y > maxY + 1e-6) {
    return false;
  }
  return pointInPreparedPolygon(piece.prepared, x, y);
}
