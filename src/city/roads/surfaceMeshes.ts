/**
 * Normalized road surface pieces (payload 0.2.0).
 *
 * The pipeline partitions the road corridor into non-overlapping pieces of kind
 * `drivable | paving | kerb | median`, with drivable pieces further split by
 * surface material. Because the pieces of one layer share edges instead of
 * overlapping, they are drawn at their exact semantic layer height with **no
 * per-polygon jitter** — coplanar overlap (the old z-fighting source) cannot
 * happen by construction.
 *
 * Piece layers (exact `ENV_LAYER_Y`, never `layerY` jitter):
 *   drivable -> road, paving -> sidewalk, kerb -> kerb, median -> median.
 *
 * Bridge pieces are raised by `BRIDGE_RAISE_M` and get a vertical skirt down to
 * the ground plane (`emitBridgeSides`), exactly like the legacy buffered road
 * bridges, so a raised deck never floats. A deck edge where the ground-level
 * carriageway continues (a deck *end*, not a bridge side over water/land) gets
 * no skirt, otherwise a full-width black wall would cut across the avenue; the
 * tile's non-bridge drivable pieces are prepared once per tile for that test.
 *
 * Colours come from the shared art-direction palette, one flat tone per
 * material (no per-class tints): the partition edge is the material change.
 */

import type { Polygon, RoadMaterial, RoadSurfaceKind, RoadSurfacePiece } from '../../shared/types';
import {
  KERB_COLOR,
  MEDIAN_COLOR,
  PAVING_COLOR,
  SURFACE_COLORS,
} from '../../engine/materials/palette';
import type { GeometrySink } from '../environment/meshBuilder';
import {
  BRIDGE_RAISE_M,
  ENV_LAYER_Y,
  ringTouchesBounds,
  type Bounds4,
  type EnvLayerKey,
} from '../environment/envLayers';
import {
  prepareFlatPolygon,
  triangulatePrepared,
  type PreparedPolygon,
  type Triangle2,
} from '../environment/triangulate';
import { emitBridgeSides } from './bridgeSides';

/** Exact layer of each normalized surface kind (no jitter is applied). */
export const SURFACE_LAYER: Record<RoadSurfaceKind, EnvLayerKey> = {
  drivable: 'road',
  paving: 'sidewalk',
  kerb: 'kerb',
  median: 'median',
};

/**
 * Smallest piece area rendered, m². The pipeline drops partition parts below
 * 0.05 m²; accepting a little below that keeps legitimate kerb slivers while
 * still rejecting numeric noise.
 */
const MIN_PIECE_AREA_M2 = 0.01;

/** Counters for the normalized road surface pass. */
export interface RoadSurfaceStats {
  /** Pieces actually emitted. */
  pieces: number;
  /** Triangles emitted (decks + bridge skirts). */
  triangles: number;
  drivablePieces: number;
  pavingPieces: number;
  kerbPieces: number;
  medianPieces: number;
  /** Drivable pieces per material (bridge decks included). */
  materials: Record<RoadMaterial, number>;
  bridgePieces: number;
  bridgeTriangles: number;
  /**
   * Bridge deck edges that got no skirt because the ground carriageway
   * continues there (a deck end, not a bridge side).
   */
  bridgeEdgesSkipped: number;
  /** Pieces whose bbox does not touch the tile (culled before triangulation). */
  culledPieces: number;
  /** Malformed records (missing polygon / unknown kind). */
  skippedPieces: number;
  /** Record looked valid but could not be triangulated. */
  degeneratePieces: number;
}

export function createRoadSurfaceStats(): RoadSurfaceStats {
  return {
    pieces: 0,
    triangles: 0,
    drivablePieces: 0,
    pavingPieces: 0,
    kerbPieces: 0,
    medianPieces: 0,
    materials: { asphalt: 0, stone: 0, concrete: 0, unpaved: 0 },
    bridgePieces: 0,
    bridgeTriangles: 0,
    bridgeEdgesSkipped: 0,
    culledPieces: 0,
    skippedPieces: 0,
    degeneratePieces: 0,
  };
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<RoadSurfaceKind>([
  'drivable',
  'paving',
  'kerb',
  'median',
]);

function isSurfaceKind(value: unknown): value is RoadSurfaceKind {
  return typeof value === 'string' && KNOWN_KINDS.has(value);
}

function isRoadMaterial(value: unknown): value is RoadMaterial {
  return value === 'asphalt' || value === 'stone' || value === 'concrete' || value === 'unpaved';
}

/** Flat colour of one piece: one tone per kind, one per drivable material. */
export function surfacePieceColor(kind: RoadSurfaceKind, material: RoadMaterial | undefined): string {
  switch (kind) {
    case 'drivable': {
      const resolved = isRoadMaterial(material) ? material : 'asphalt';
      return SURFACE_COLORS[resolved];
    }
    case 'kerb':
      return KERB_COLOR;
    case 'median':
      return MEDIAN_COLOR;
    case 'paving':
    default:
      return PAVING_COLOR;
  }
}

/**
 * Per-tile emission context. Ground-level drivable pieces are prepared lazily
 * (only tiles with bridge decks need them) and reused for every bridge edge.
 */
interface SurfaceEmitContext {
  pieces: RoadSurfacePiece[];
  groundDrivable: PreparedPolygon[] | null;
}

/**
 * Emit every normalized road surface piece into the shared roads sink.
 * Defensive by design: malformed pieces are counted and skipped, never thrown.
 */
export function emitRoadSurfaces(
  sink: GeometrySink,
  pieces: RoadSurfacePiece[] | null | undefined,
  bounds: Bounds4,
  stats: RoadSurfaceStats,
  options: { bridgesOnly?: boolean } = {},
): void {
  if (!Array.isArray(pieces) || pieces.length === 0) return;
  const context: SurfaceEmitContext = { pieces, groundDrivable: null };
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    if (!piece || typeof piece !== 'object' || !Array.isArray(piece.polygon)) {
      stats.skippedPieces++;
      continue;
    }
    // Raster ground mode: the flat ground (incl. all ground-level road
    // surfaces) is a texture; only raised bridge decks remain geometry.
    if (options.bridgesOnly && piece.bridge !== true) continue;
    if (!isSurfaceKind(piece.kind)) {
      stats.skippedPieces++;
      continue;
    }
    try {
      emitPiece(sink, piece, piece.kind, bounds, stats, context);
    } catch {
      // One malformed piece must never break the whole tile.
      stats.skippedPieces++;
    }
  }
}

/** Prepare (once) the tile's ground-level drivable pieces for deck-end tests. */
function groundDrivablePieces(context: SurfaceEmitContext): PreparedPolygon[] {
  if (context.groundDrivable) return context.groundDrivable;
  const prepared: PreparedPolygon[] = [];
  for (const piece of context.pieces) {
    if (!piece || piece.kind !== 'drivable' || piece.bridge === true) continue;
    if (!Array.isArray(piece.polygon)) continue;
    try {
      const polygon = prepareFlatPolygon(piece.polygon as Polygon, {
        minArea: MIN_PIECE_AREA_M2,
      });
      if (polygon) prepared.push(polygon);
    } catch {
      // A broken ground piece simply cannot hide a deck end.
    }
  }
  context.groundDrivable = prepared;
  return prepared;
}

function emitPiece(
  sink: GeometrySink,
  piece: RoadSurfacePiece,
  kind: RoadSurfaceKind,
  bounds: Bounds4,
  stats: RoadSurfaceStats,
  context: SurfaceEmitContext,
): void {
  let prepared: PreparedPolygon | null = null;
  try {
    prepared = prepareFlatPolygon(piece.polygon as Polygon, { minArea: MIN_PIECE_AREA_M2 });
  } catch {
    prepared = null;
  }
  if (!prepared) {
    stats.degeneratePieces++;
    return;
  }
  if (!ringTouchesBounds(prepared.exterior, bounds)) {
    // Surface pieces are pre-clipped per tile; anything not touching this tile
    // belongs to another tile (or is a stale payload) and is not drawn here.
    stats.culledPieces++;
    return;
  }
  let triangles: Triangle2[] = [];
  try {
    triangles = triangulatePrepared(prepared);
  } catch {
    triangles = [];
  }
  if (triangles.length === 0) {
    stats.degeneratePieces++;
    return;
  }

  const color = surfacePieceColor(kind, piece.material);
  const baseY = ENV_LAYER_Y[SURFACE_LAYER[kind]];
  if (piece.bridge === true) {
    // Raised deck (no ramps) + vertical skirt down to the ground plane. Edges
    // where the ground carriageway continues are deck ends and get no wall.
    //
    // Only the drivable deck gets a structural side wall: paving on a bridge is
    // a thin slab sitting 5 cm above the deck, so its own skirt would be a
    // second dark wall along the deck edge (and a visible face where sidewalk
    // meets ground paving). Bridge sidewalks therefore stay flat.
    const deckY = baseY + BRIDGE_RAISE_M;
    const deckTriangles = sink.addFlatTriangles(triangles, deckY, color);
    let sideTriangles = 0;
    if (kind === 'drivable') {
      const edgeCounter = { skippedEdges: 0 };
      sideTriangles = emitBridgeSides(sink, prepared, deckY, color, {
        groundDrivable: groundDrivablePieces(context),
        stats: edgeCounter,
      });
      stats.bridgeEdgesSkipped += edgeCounter.skippedEdges;
    }
    stats.triangles += deckTriangles + sideTriangles;
    stats.bridgeTriangles += deckTriangles + sideTriangles;
    stats.bridgePieces++;
  } else {
    stats.triangles += sink.addFlatTriangles(triangles, baseY, color);
  }

  stats.pieces++;
  switch (kind) {
    case 'drivable':
      stats.drivablePieces++;
      stats.materials[isRoadMaterial(piece.material) ? piece.material : 'asphalt']++;
      break;
    case 'paving':
      stats.pavingPieces++;
      break;
    case 'kerb':
      stats.kerbPieces++;
      break;
    case 'median':
      stats.medianPieces++;
      break;
  }
}
