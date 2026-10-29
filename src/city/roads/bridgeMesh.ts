/**
 * Bridge detail: concrete parapets, lamp posts and piers on raised decks.
 *
 * The pipeline marks `bridge=yes` roads; `roadMeshes.ts` raises the deck and
 * drops a skirt to the ground. With a centreline available we add what makes a
 * bridge read at close zoom:
 *  - a continuous light-concrete parapet wall (0.95 m tall, 0.3 m thick) along
 *    both deck edges — the strongest visual cue at any zoom;
 *  - short lamp/finial posts on the parapet every 6 m;
 *  - concrete piers under the deck.
 *
 * Everything is clipped to the deck polygon (a tile-cut bridge only gets
 * detail where the deck actually is).
 */

import type { RoadPolygon } from '../../shared/types';
import { ROAD_WIDTH_M } from '../../engine/materials/palette';
import type { GeometrySink, Vec3 } from '../environment/meshBuilder';
import type { PreparedPolygon } from '../environment/triangulate';
import { pointInPreparedPolygon } from './roadAnalysis';
import { offsetAlong, type PathStation } from './roadPath';
import { BRIDGE_PIER_COLOR, BRIDGE_RAIL_COLOR } from './roadColors';

export interface BridgeStats {
  railPosts: number;
  piers: number;
  triangles: number;
}

export function createBridgeStats(): BridgeStats {
  return { railPosts: 0, piers: 0, triangles: 0 };
}

/** Parapet geometry, metres. */
const PARAPET_HEIGHT_M = 0.95;
const PARAPET_HALF_THICKNESS_M = 0.15;
/** Finial post spacing along the parapet, metres. */
const POST_SPACING_M = 6.0;
const POST_HALF_M = 0.11;
const POST_HEIGHT_M = 0.8;
/** First/last detail inset from the deck ends, metres. */
const END_INSET_M = 1.6;
/** Pier spacing and dimensions, metres. */
const PIER_SPACING_M = 20;
const PIER_END_INSET_M = 9;
const PIER_HALF_ALONG_M = 0.6;
const PIER_HALF_ACROSS_M = 0.45;
/** Finial posts are a slightly darker stone than the parapet. */
const POST_COLOR = '#a5a094';

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** Interpolate a station at arc length `s` from the resampled stations. */
function stationAtS(stations: readonly PathStation[], s: number): PathStation | null {
  if (stations.length < 2) return null;
  if (s <= stations[0].s) return stations[0];
  if (s >= stations[stations.length - 1].s) return stations[stations.length - 1];
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1];
    const b = stations[i];
    if (s <= b.s) {
      const span = b.s - a.s;
      const t = span > 1e-6 ? (s - a.s) / span : 0;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        ux: a.ux + (b.ux - a.ux) * t,
        uy: a.uy + (b.uy - a.uy) * t,
        s,
      };
    }
  }
  return stations[stations.length - 1];
}

/**
 * Emit the parapet, posts and piers for one bridge deck. `deckY` is the world
 * height of the deck surface; piers reach the ground plane.
 */
export function emitBridgeDetails(
  sink: GeometrySink,
  road: RoadPolygon,
  prepared: PreparedPolygon,
  stations: readonly PathStation[],
  deckY: number,
  stats: BridgeStats,
  maxTriangles: number,
  /** Other bridge decks of the tile: a shared edge gets no double parapet. */
  otherDecks: readonly PreparedPolygon[] = [],
): void {
  if (!road.bridge || road.kind !== 'road') return;
  if (stations.length < 3) return;
  const total = stations[stations.length - 1].s;
  if (total < 10) return;
  const startTriangles = sink.triangleCount;
  const overCap = (): boolean =>
    stats.triangles + (sink.triangleCount - startTriangles) >= maxTriangles;

  const width = Number.isFinite(road.width) && road.width > 1
    ? road.width
    : (ROAD_WIDTH_M[road.class] ?? 8);
  const half = width / 2;
  const railOffset = clamp(half - 0.35, 0.8, 30);
  const parquetHalf = PARAPET_HALF_THICKNESS_M;
  const innerOffset = railOffset - parquetHalf;

  // A carriageway pair mapped as two overlapping bridge ways must not paint two
  // back-to-back parapets down the middle: skip a side whose inner line lies on
  // another bridge deck of the tile.
  const midStation = stationAtS(stations, total / 2);
  const sharedSide = (side: -1 | 1): boolean => {
    if (!midStation) return false;
    const point = offsetAlong(midStation, side * innerOffset);
    for (const other of otherDecks) {
      if (other === prepared) continue;
      if (pointInPreparedPolygon(other, point[0], point[1])) return true;
    }
    return false;
  };
  const sideShared: Record<number, boolean> = {
    [-1]: sharedSide(-1),
    [1]: sharedSide(1),
  };

  // 1. Continuous parapet wall along both deck edges: inner face, outer face
  //    and a top cap. Only the INNER corners must be on the deck — the outer
  //    face can sit on the polygon boundary (requiring all four corners inside
  //    made the wall break into dashes along curves).
  for (let i = 1; i < stations.length; i++) {
    if (overCap()) break;
    const previous = stations[i - 1];
    const current = stations[i];
    if (current.s - previous.s > 4) continue;
    for (const side of [-1, 1] as const) {
      if (sideShared[side]) continue;
      const outerA = offsetAlong(previous, side * (railOffset + parquetHalf));
      const outerB = offsetAlong(current, side * (railOffset + parquetHalf));
      const innerA = offsetAlong(previous, side * innerOffset);
      const innerB = offsetAlong(current, side * innerOffset);
      if (!pointInPreparedPolygon(prepared, innerA[0], innerA[1])) continue;
      if (!pointInPreparedPolygon(prepared, innerB[0], innerB[1])) continue;
      const nx = -previous.uy * side;
      const ny = previous.ux * side;
      const topY = deckY + PARAPET_HEIGHT_M;
      // Outer face.
      sink.addOrientedQuad(
        [outerA[0], deckY, -outerA[1]],
        [outerB[0], deckY, -outerB[1]],
        [outerB[0], topY, -outerB[1]],
        [outerA[0], topY, -outerA[1]],
        [nx, 0, -ny],
        BRIDGE_RAIL_COLOR,
      );
      // Inner face.
      sink.addOrientedQuad(
        [innerB[0], deckY, -innerB[1]],
        [innerA[0], deckY, -innerA[1]],
        [innerA[0], topY, -innerA[1]],
        [innerB[0], topY, -innerB[1]],
        [-nx, 0, ny],
        BRIDGE_RAIL_COLOR,
      );
      // Top cap.
      sink.addFlatQuad(outerA, outerB, innerB, innerA, topY, BRIDGE_RAIL_COLOR);
    }
  }

  // 2. Finial / lamp posts on the parapet.
  for (let s = END_INSET_M; s <= total - END_INSET_M; s += POST_SPACING_M) {
    if (overCap()) break;
    const station = stationAtS(stations, s);
    if (!station) continue;
    let emitted = false;
    for (const side of [-1, 1] as const) {
      if (sideShared[side]) continue;
      const point = offsetAlong(station, side * railOffset);
      if (!pointInPreparedPolygon(prepared, point[0], point[1])) continue;
      emitBox(
        sink,
        point[0],
        point[1],
        deckY + PARAPET_HEIGHT_M,
        deckY + PARAPET_HEIGHT_M + POST_HEIGHT_M,
        POST_HALF_M,
        POST_HALF_M,
        station.ux,
        station.uy,
        POST_COLOR,
      );
      emitted = true;
    }
    if (emitted) stats.railPosts++;
  }

  // 3. Piers under the deck.
  for (let s = PIER_END_INSET_M; s <= total - PIER_END_INSET_M; s += PIER_SPACING_M) {
    if (overCap()) break;
    const station = stationAtS(stations, s);
    if (!station) continue;
    let emitted = false;
    for (const side of [-1, 1] as const) {
      const point = offsetAlong(station, side * Math.max(0.5, half - 1.0));
      if (!pointInPreparedPolygon(prepared, point[0], point[1])) continue;
      emitBox(
        sink,
        point[0],
        point[1],
        0,
        deckY - 0.2,
        PIER_HALF_ALONG_M,
        PIER_HALF_ACROSS_M,
        station.ux,
        station.uy,
        BRIDGE_PIER_COLOR,
      );
      emitted = true;
    }
    if (emitted) stats.piers++;
  }

  stats.triangles += sink.triangleCount - startTriangles;
}

/**
 * Four vertical faces of a box aligned with the road frame (u along the road,
 * n across it) between two heights.
 */
function emitBox(
  sink: GeometrySink,
  x: number,
  y: number,
  bottomY: number,
  topY: number,
  halfAlong: number,
  halfAcross: number,
  ux: number,
  uy: number,
  color: string,
): void {
  const nx = -uy;
  const ny = ux;
  const faces: Array<{
    ox: number;
    oy: number;
    wx: number;
    wy: number;
    half: number;
  }> = [
    { ox: x + ux * halfAlong, oy: y + uy * halfAlong, wx: ux, wy: uy, half: halfAcross },
    { ox: x - ux * halfAlong, oy: y - uy * halfAlong, wx: -ux, wy: -uy, half: halfAcross },
    { ox: x + nx * halfAcross, oy: y + ny * halfAcross, wx: nx, wy: ny, half: halfAlong },
    { ox: x - nx * halfAcross, oy: y - ny * halfAcross, wx: -nx, wy: -ny, half: halfAlong },
  ];
  for (const face of faces) {
    const tx = -face.wy;
    const ty = face.wx;
    const a: Vec3 = [face.ox - tx * face.half, bottomY, -(face.oy - ty * face.half)];
    const b: Vec3 = [face.ox + tx * face.half, bottomY, -(face.oy + ty * face.half)];
    const c: Vec3 = [face.ox + tx * face.half, topY, -(face.oy + ty * face.half)];
    const d: Vec3 = [face.ox - tx * face.half, topY, -(face.oy - ty * face.half)];
    sink.addOrientedQuad(a, b, c, d, [face.wx, 0, -face.wy], color);
  }
}
