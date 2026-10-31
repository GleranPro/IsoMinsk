/**
 * Vertical bridge skirts: connect a raised flat deck to the ground plane.
 *
 * Bridge decks (legacy road polygons and normalized road surface pieces alike)
 * are drawn `BRIDGE_RAISE_M` above their normal layer with no ramps, so a deck
 * on its own would float in mid air. This helper emits one vertical quad per
 * polygon edge from the deck height down to y = 0, with the correct outward
 * facing normal. Exterior rings face outwards; hole rings are oriented so their
 * walls face into the hole.
 *
 * Deck **ends** are not bridge sides: where a raised deck runs into the
 * ground-level carriageway, a full-width skirt would read as a black wall
 * straight across the street. Given the tile's ground-level drivable pieces,
 * an edge whose outward side lies inside one of them is therefore skipped (the
 * deck just steps down to the ground road with no vertical face); skirts over
 * water, paving and land are kept.
 *
 * Kept in its own module (and re-exported from `roadMeshes.ts`) so both the
 * legacy buffered-polygon renderer and the payload-0.2.0 surface renderer can
 * share it without a module import cycle.
 */

import { shadeHex } from '../../engine/materials/palette';
import type { GeometrySink, Vec3 } from '../environment/meshBuilder';
import { signedRingArea, type PreparedPolygon } from '../environment/triangulate';
import { pointInPreparedPolygon } from './roadAnalysis';

/** How far off the deck edge the ground-side probe point sits, metres. */
const EDGE_PROBE_M = 0.05;

export interface BridgeSidesOptions {
  /**
   * Ground-level (non-bridge) drivable pieces of the tile. An edge whose
   * outward midpoint probe lands inside one of these is a deck end meeting the
   * ground road, so no vertical side is emitted there.
   */
  groundDrivable?: readonly PreparedPolygon[];
  /** Optional counters written while emitting. */
  stats?: { skippedEdges: number };
}

/**
 * Emit the skirt of a raised deck down to the ground plane and return the
 * number of triangles added.
 */
export function emitBridgeSides(
  sink: GeometrySink,
  prepared: PreparedPolygon,
  deckY: number,
  topColor: string,
  options: BridgeSidesOptions = {},
): number {
  const color = shadeHex(topColor, -0.28);
  const ground = options.groundDrivable ?? [];
  const counter = options.stats;
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
      // World-space outward normal [dy/len, 0, dx/len] in local metres is
      // (dy/len, -dx/len) because world z = -local y.
      const outX = dy / length;
      const outY = -dx / length;
      if (ground.length > 0 && isGroundEnd((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, outX, outY, ground)) {
        if (counter) counter.skippedEdges++;
        continue;
      }
      const outward: Vec3 = [outX, 0, -outY];
      const topA: Vec3 = [a[0], deckY, -a[1]];
      const topB: Vec3 = [b[0], deckY, -b[1]];
      const bottomA: Vec3 = [a[0], 0, -a[1]];
      const bottomB: Vec3 = [b[0], 0, -b[1]];
      sink.addOrientedQuad(topA, topB, bottomB, bottomA, outward, color);
    }
  }
  return sink.triangleCount - before;
}

/** True when the ground road continues just beyond this deck edge. */
function isGroundEnd(
  midX: number,
  midY: number,
  outX: number,
  outY: number,
  ground: readonly PreparedPolygon[],
): boolean {
  const probeX = midX + outX * EDGE_PROBE_M;
  const probeY = midY + outY * EDGE_PROBE_M;
  for (const piece of ground) {
    if (pointInPreparedPolygon(piece, probeX, probeY)) return true;
  }
  return false;
}
