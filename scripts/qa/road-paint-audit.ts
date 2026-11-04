// Road paint audit — payload 0.3.0 (tsx, no browser).
//
// Independent QA for the graph-based road pipeline:
//  1. lane-paint triangles (the `ENV_LAYER_Y.markings` quads emitted by the
//     road-network pass) must not fall inside a junction face polygon, within a
//     0.45 m buffer, and must not sit on a synthetic junction surface piece;
//     zebra bars and crossing stop lines must not fall inside junction faces
//     either. Authoritative approach stop bars (`junction.approachEdges[]
//     .stopLine`) are painted ON the face boundary by contract, so they are
//     matched by position and excluded from the stop-line containment failure;
//  2. every painted road piece must get the centre/divider line layout its lane
//     metadata implies:
//       - link / service / roundabout -> 0 centre + 0 dividers
//       - one-way -> 0 centre + (lanes - 1) dividers
//       - two-way -> 1 logical centre + (lanesForward - 1) + (lanesBackward - 1)
//         dividers (a double solid centre counts as one logical centre line)
//     laneMarkingLayout() from src/city/roads/networkMeshes.ts is compared with
//     this independent expectation, so a renderer that paints a 3-lane street as
//     2 lanes (or paints link/service/roundabout approaches) fails here;
//  3. `lanesSource === 'tag'` pieces must carry usable tagged lane counts;
//  4. tram rails exist on the rail tiles, have no lane metadata, and at least
//     one rail centreline passes within 10 m of the Ulyanovskaya x Lenina
//     junction face while continuing across the junction area (rails do not
//     have to run inside the face polygon — they can be offset from the road
//     centreline);
//  5. per-place summary for Ulyanovskaya x Lenina (~289,-719), the Independence
//     Avenue corridor and the Lenina 1+2 asymmetric segment.
//
// Usage (PowerShell, repo root, after `pnpm run data:normalize`):
//   pnpm exec tsx scripts/qa/road-paint-audit.ts
// Exits 1 on violations and writes screenshots/road-paint-audit.json.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { BRIDGE_RAISE_M, ENV_LAYER_Y } from '../../src/city/environment/envLayers';
import { buildEnvironmentMeshes } from '../../src/city/environment/environmentMeshes';
import {
  CROSSING_PAINT_Y,
  CROSSING_STOP_LINE_Y,
  laneMarkingLayout,
} from '../../src/city/roads/networkMeshes';
import type {
  JunctionFeature,
  Polygon,
  Ring,
  RoadNetworkPiece,
  RoadSurfacePiece,
  TileData,
  TileManifest,
} from '../../src/shared/types';

const TILE_DIR = 'public/data/tiles';
/** Lane paint must keep this far away from a junction face boundary. */
const JUNCTION_PAINT_CLEARANCE_M = 0.45;
/** Tolerance for matching a triangle's Y to the exact marking layer. */
const PAINT_Y_EPSILON_M = 1e-4;
/** Places to summarise. */
const ULYANOVSKAYA_LENINA = { x: 289, y: -719 };
const LENINA_ASYMMETRIC = { x: 240, y: -690 };

// ---------------------------------------------------------------------------
// local geometry helpers (independent of src/)
// ---------------------------------------------------------------------------

type RingBox = { minX: number; minY: number; maxX: number; maxY: number };

function ringBBox(ring: Ring): RingBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function boxesOverlap(a: RingBox, b: RingBox, margin = 0): boolean {
  return (
    a.minX <= b.maxX + margin &&
    a.maxX >= b.minX - margin &&
    a.minY <= b.maxY + margin &&
    a.maxY >= b.minY - margin
  );
}

/** Ray-casting point-in-ring (even-odd). */
function pointInRing(point: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > point[1] !== yj > point[1];
    if (crosses && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: [number, number], polygon: Polygon): boolean {
  if (!pointInRing(point, polygon[0])) return false;
  for (let index = 1; index < polygon.length; index += 1) {
    if (pointInRing(point, polygon[index])) return false;
  }
  return true;
}

function segmentDistance(
  point: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

function polygonBoundaryDistance(point: [number, number], polygon: Polygon): number {
  let best = Infinity;
  for (const ring of polygon) {
    for (let index = 0; index < ring.length; index += 1) {
      const distance = segmentDistance(point, ring[index], ring[(index + 1) % ring.length]);
      if (distance < best) best = distance;
    }
  }
  return best;
}

function polygonArea(polygon: Polygon): number {
  let area = 0;
  for (const ring of polygon) {
    let sum = 0;
    for (let index = 0; index < ring.length; index += 1) {
      const [x0, y0] = ring[index];
      const [x1, y1] = ring[(index + 1) % ring.length];
      sum += x0 * y1 - x1 * y0;
    }
    area += Math.abs(sum) / 2;
  }
  return area;
}

/** Densify a polyline so junction traversal is not missed between payload vertices. */
function samplePolyline(points: readonly [number, number][], step = 1.0): Array<[number, number]> {
  if (points.length === 0) return [];
  const samples: Array<[number, number]> = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const [ax, ay] = points[index - 1];
    const [bx, by] = points[index];
    const length = Math.hypot(bx - ax, by - ay);
    const count = Math.max(1, Math.ceil(length / step));
    for (let s = 1; s <= count; s += 1) {
      const t = s / count;
      samples.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
  }
  return samples;
}

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

/** Paint family of one emitted triangle, classified by its exact layer height. */
type PaintFamily = 'lane' | 'zebra' | 'stop';

interface PaintTriangle {
  centroid: [number, number];
  tile: string;
  height: number;
  family: PaintFamily;
}

interface ApproachStopBar {
  x: number;
  y: number;
  angle: number;
  width: number;
}

interface JunctionFace {
  id: string;
  polygon: Polygon;
  box: RingBox;
  tile: string;
  fallback: boolean;
  approaches: number;
  approachEdges: number;
  area: number;
}

interface JunctionSurface {
  polygon: Polygon;
  box: RingBox;
  tile: string;
}

interface LayoutRecord {
  tile: string;
  piece: RoadNetworkPiece;
  label: string;
  places: string[];
  expectedCentre: number;
  expectedDividers: number;
  checkedCentre: boolean;
  checkedDividers: boolean;
  actualCentre: number;
  actualDividers: number;
  problems: string[];
}

interface RailRecord {
  tile: string;
  piece: RoadNetworkPiece;
  label: string;
  centreline: Array<[number, number]>;
}

const manifestPath = join(TILE_DIR, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TileManifest;
const tiles: Array<{ name: string; data: TileData }> = manifest.tiles.map((entry) => ({
  name: `${entry.x}_${entry.y}`,
  data: JSON.parse(readFileSync(join(TILE_DIR, entry.file.split('/').pop() ?? entry.file), 'utf8')) as TileData,
}));

const violations: string[] = [];
const paintTriangles: PaintTriangle[] = [];
const junctionFaces: JunctionFace[] = [];
const junctionSurfaces: JunctionSurface[] = [];
const layoutRecords: LayoutRecord[] = [];
const railRecords: RailRecord[] = [];
/** Authoritative approach stop bars from junction.approachEdges[].stopLine. */
const approachStopBars: ApproachStopBar[] = [];
/**
 * Exact layer heights of the three paint families. Lane paint lives at the
 * marking layer (raised on bridge decks); zebra bars and stop lines use the two
 * crossing layers above it (payload 0.2.0/0.3.0 renderer contract).
 */
const paintLayers: Array<{ family: PaintFamily; y: number }> = [
  { family: 'lane', y: ENV_LAYER_Y.markings },
  { family: 'lane', y: ENV_LAYER_Y.markings + BRIDGE_RAISE_M },
  { family: 'zebra', y: CROSSING_PAINT_Y },
  { family: 'zebra', y: CROSSING_PAINT_Y + BRIDGE_RAISE_M },
  { family: 'stop', y: CROSSING_STOP_LINE_Y },
  { family: 'stop', y: CROSSING_STOP_LINE_Y + BRIDGE_RAISE_M },
];

// ---------------------------------------------------------------------------
// 1) collect junction faces / junction surfaces + lane-paint triangles
// ---------------------------------------------------------------------------

const seenJunctionIds = new Set<string>();
const seenApproachStopBars = new Set<string>();

function junctionKey(junction: JunctionFeature, tileName: string): string {
  if (typeof junction.id === 'string' && junction.id.length > 0) return junction.id;
  return `${tileName}:${junction.x.toFixed(2)},${junction.y.toFixed(2)}`;
}

for (const { name: tileName, data } of tiles) {
  for (const junction of data.junctions ?? []) {
    if (!junction.polygon) continue;
    // Junction faces are clipped per tile by the pipeline (payload 0.3.0), so
    // records with the same id in neighbouring tiles are *different fragments*
    // and must all take part in paint containment.
    const key = junctionKey(junction, tileName);
    seenJunctionIds.add(key);
    junctionFaces.push({
      id: typeof junction.id === 'string' ? junction.id : key,
      polygon: junction.polygon,
      box: ringBBox(junction.polygon[0] as Ring),
      tile: tileName,
      fallback: junction.fallback === true,
      approaches: junction.approaches,
      approachEdges: junction.approachEdges?.length ?? 0,
      area: polygonArea(junction.polygon),
    });
    // Approach stop bars are authoritative boundary elements: the renderer
    // paints them ON the junction face edge, so they must be excluded from the
    // "no crossing paint inside a face" rule below.
    for (const edge of junction.approachEdges ?? []) {
      const stopLine = edge?.stopLine;
      if (!stopLine) continue;
      if (
        !Number.isFinite(stopLine.x) ||
        !Number.isFinite(stopLine.y) ||
        !Number.isFinite(stopLine.angle) ||
        !Number.isFinite(stopLine.width) ||
        !(stopLine.width > 0)
      ) {
        continue;
      }
      const barKey = `${stopLine.x.toFixed(2)},${stopLine.y.toFixed(2)},${stopLine.angle.toFixed(3)},${stopLine.width.toFixed(2)}`;
      if (seenApproachStopBars.has(barKey)) continue;
      seenApproachStopBars.add(barKey);
      approachStopBars.push({
        x: stopLine.x,
        y: stopLine.y,
        angle: stopLine.angle,
        width: stopLine.width,
      });
    }
  }
  for (const piece of data.roadSurfaces ?? []) {
    if (piece.junction !== true) continue;
    if (!Array.isArray(piece.polygon) || piece.polygon.length === 0) continue;
    junctionSurfaces.push({
      polygon: piece.polygon as Polygon,
      box: ringBBox(piece.polygon[0] as Ring),
      tile: tileName,
    });
  }
}

/** True when a stop-line triangle belongs to an authoritative approach bar. */
function isApproachStopBarTriangle(point: [number, number]): boolean {
  for (const bar of approachStopBars) {
    const dx = point[0] - bar.x;
    const dy = point[1] - bar.y;
    const ux = Math.cos(bar.angle);
    const uy = Math.sin(bar.angle);
    const along = dx * ux + dy * uy;
    const across = -dx * uy + dy * ux;
    // Bar is `width` long across the carriageway and 0.5 m thick along travel;
    // allow for triangle centroids offset up to ~1/3 of the bar dimensions.
    if (Math.abs(along) <= 0.7 && Math.abs(across) <= bar.width / 2 + 0.7) return true;
  }
  return false;
}

function extractPaint(tileName: string, geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const index = geometry.getIndex();
  if (!position || !index) return;
  for (let i = 0; i + 2 < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    const ys = [position.getY(a), position.getY(b), position.getY(c)];
    let family: PaintFamily | null = null;
    for (const layer of paintLayers) {
      if (ys.every((y) => Math.abs(y - layer.y) <= PAINT_Y_EPSILON_M)) {
        family = layer.family;
        break;
      }
    }
    if (!family) continue;
    const centroid: [number, number] = [
      (position.getX(a) + position.getX(b) + position.getX(c)) / 3,
      -(position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3,
    ];
    paintTriangles.push({ centroid, tile: tileName, height: ys[0], family });
  }
}

// ---------------------------------------------------------------------------
// 2) expected lane layout per painted piece
// ---------------------------------------------------------------------------

interface LaneExpectation {
  centre: number;
  dividers: number;
  checkedCentre: boolean;
  checkedDividers: boolean;
  problems: string[];
}

const NO_PAINT_CLASSES = new Set(['service']);

function expectLaneLayout(piece: RoadNetworkPiece): LaneExpectation {
  const problems: string[] = [];
  if (piece.kind === 'rail') {
    if (piece.lanes !== undefined || piece.lanesForward !== undefined || piece.lanesBackward !== undefined) {
      problems.push('rail piece must not carry lane counts');
    }
    return { centre: 0, dividers: 0, checkedCentre: true, checkedDividers: true, problems };
  }
  if (piece.kind !== 'road' || piece.material !== 'asphalt') {
    // Lane-paint pass only paints asphalt road pieces.
    return { centre: 0, dividers: 0, checkedCentre: false, checkedDividers: false, problems };
  }
  if (piece.link === true || piece.roundabout === true || NO_PAINT_CLASSES.has(piece.class)) {
    return { centre: 0, dividers: 0, checkedCentre: true, checkedDividers: true, problems };
  }

  const lanes = Number.isInteger(piece.lanes) ? (piece.lanes as number) : undefined;
  const forward = Number.isInteger(piece.lanesForward) ? (piece.lanesForward as number) : undefined;
  const backward = Number.isInteger(piece.lanesBackward) ? (piece.lanesBackward as number) : undefined;
  const oneWay = piece.merged !== true && piece.oneway === true;

  if (piece.lanesSource === 'tag' && forward === undefined) {
    problems.push("lanesSource='tag' but lanesForward is missing");
  }

  if (oneWay) {
    const laneCount = forward ?? lanes;
    if (laneCount === undefined) {
      return { centre: 0, dividers: 0, checkedCentre: true, checkedDividers: false, problems };
    }
    if (laneCount < 1) problems.push(`one-way lane count ${laneCount} < 1`);
    if (backward !== undefined && backward !== 0) {
      problems.push(`one-way lanesBackward=${backward} must be 0`);
    }
    if (laneCount !== undefined && lanes !== undefined && lanes !== laneCount) {
      problems.push(`one-way lanes=${lanes} != lanesForward=${laneCount}`);
    }
    return {
      centre: 0,
      dividers: Math.max(0, laneCount - 1),
      checkedCentre: true,
      checkedDividers: true,
      problems,
    };
  }

  // Two-way (merged corridors are always two-way).
  if (forward === undefined || backward === undefined) {
    if (piece.lanesSource === 'tag') {
      problems.push("two-way lanesSource='tag' requires both lanesForward and lanesBackward");
    }
    return { centre: 1, dividers: 0, checkedCentre: true, checkedDividers: false, problems };
  }
  if (forward < 1) problems.push(`two-way lanesForward ${forward} < 1`);
  if (backward < 1) problems.push(`two-way lanesBackward ${backward} < 1`);
  if (lanes !== undefined && lanes !== forward + backward) {
    problems.push(`two-way lanes=${lanes} != lanesForward+lanesBackward=${forward + backward}`);
  }
  return {
    centre: 1,
    dividers: Math.max(0, forward - 1) + Math.max(0, backward - 1),
    checkedCentre: true,
    checkedDividers: true,
    problems,
  };
}

function countActualLayout(piece: RoadNetworkPiece): { centre: number; dividers: number } {
  const lines = laneMarkingLayout(piece);
  let centre = 0;
  let dividers = 0;
  for (const line of lines) {
    if (line.kind === 'centre') centre = 1; // double solid = one logical centre line
    else if (line.kind === 'divider') dividers += 1;
  }
  return { centre, dividers };
}

// ---------------------------------------------------------------------------
// 3) places (per-piece tagging for the summary)
// ---------------------------------------------------------------------------

function distanceToCenterline(piece: RoadNetworkPiece, point: [number, number]): number {
  const flat = piece.centerline;
  let best = Infinity;
  for (let index = 0; index + 3 < flat.length; index += 2) {
    const distance = segmentDistance(
      point,
      [flat[index], flat[index + 1]],
      [flat[index + 2], flat[index + 3]],
    );
    if (distance < best) best = distance;
  }
  return best;
}

function placeTags(piece: RoadNetworkPiece): string[] {
  const places: string[] = [];
  if (typeof piece.name === 'string' && piece.name.includes('Незалежнасці')) places.push('Independence corridor');
  if (typeof piece.name === 'string' && piece.name.includes('Леніна')) {
    const asymmetric =
      (piece.lanesForward === 1 && piece.lanesBackward === 2) ||
      (piece.lanesForward === 2 && piece.lanesBackward === 1);
    if (asymmetric) places.push('Lenina 1+2');
  }
  if (
    piece.kind === 'road' &&
    distanceToCenterline(piece, [ULYANOVSKAYA_LENINA.x, ULYANOVSKAYA_LENINA.y]) <= 80
  ) {
    places.push('Ulyanovskaya x Lenina');
  }
  return places;
}

// ---------------------------------------------------------------------------
// audit pass per tile
// ---------------------------------------------------------------------------

interface TileSummary {
  tile: string;
  lanePaint: number;
  junctionFaces: number;
  railPieces: number;
  railTriangles: number;
  layoutChecked: number;
  layoutViolations: number;
}

const tileSummaries: TileSummary[] = [];

for (const { name: tileName, data } of tiles) {
  const env = buildEnvironmentMeshes(data, { tileBounds: data.bounds, trees: false });
  const before = paintTriangles.length;
  extractPaint(tileName, env.roads);
  const tilePaintCount = paintTriangles
    .slice(before)
    .filter((triangle) => triangle.family === 'lane').length;
  const railPieces = (data.roadNetwork ?? []).filter((piece) => piece.kind === 'rail');
  let tileLayoutChecked = 0;
  let tileLayoutViolations = 0;

  for (const piece of data.roadNetwork ?? []) {
    if (piece.kind === 'rail') {
      const flat = piece.centerline;
      const centreline: Array<[number, number]> = [];
      for (let index = 0; index + 1 < flat.length; index += 2) centreline.push([flat[index], flat[index + 1]]);
      railRecords.push({
        tile: tileName,
        piece,
        label: `${tileName}/rail(${piece.name ?? 'unnamed'})`,
        centreline,
      });
      continue;
    }
    const expectation = expectLaneLayout(piece);
    if (!expectation.checkedCentre && !expectation.checkedDividers) continue;
    tileLayoutChecked += 1;
    const label = `${tileName}/network(${String(piece.kind)}:${String(piece.class)}:${piece.name ?? 'unnamed'})`;
    const actual = countActualLayout(piece);
    const problems = [...expectation.problems];
    if (expectation.checkedCentre && actual.centre !== expectation.centre) {
      problems.push(
        `centre lines: expected ${expectation.centre}, laneMarkingLayout gives ${actual.centre}`,
      );
    }
    if (expectation.checkedDividers && actual.dividers !== expectation.dividers) {
      problems.push(
        `lane dividers: expected ${expectation.dividers} ` +
          `(lanes=${piece.lanes ?? '?'}, f=${piece.lanesForward ?? '?'}, b=${piece.lanesBackward ?? '?'}, ` +
          `oneway=${piece.oneway === true}), laneMarkingLayout gives ${actual.dividers}`,
      );
    }
    const places = placeTags(piece);
    layoutRecords.push({
      tile: tileName,
      piece,
      label,
      places,
      expectedCentre: expectation.centre,
      expectedDividers: expectation.dividers,
      checkedCentre: expectation.checkedCentre,
      checkedDividers: expectation.checkedDividers,
      actualCentre: actual.centre,
      actualDividers: actual.dividers,
      problems,
    });
    if (problems.length > 0) {
      tileLayoutViolations += 1;
      violations.push(`${label}: ${problems.join('; ')}`);
    }
  }

  if (railPieces.length > 0 && (env.counts?.roads.network.railTriangles ?? 0) === 0) {
    violations.push(`${tileName}: ${railPieces.length} rail piece(s) but no rail triangles emitted`);
  }
  tileSummaries.push({
    tile: tileName,
    lanePaint: tilePaintCount,
    junctionFaces: (data.junctions ?? []).filter((junction) => junction.polygon !== undefined).length,
    railPieces: railPieces.length,
    railTriangles: env.counts?.roads.network.railTriangles ?? 0,
    layoutChecked: tileLayoutChecked,
    layoutViolations: tileLayoutViolations,
  });
}

// ---------------------------------------------------------------------------
// 4) containment: lane paint vs junction faces / junction surfaces; zebra and
//    crossing paint must also stay out of junction faces. Approach stop bars
//    from `junction.approachEdges[].stopLine` are authoritative boundary
//    elements and are excluded from the stop-line containment failures.
// ---------------------------------------------------------------------------

let lanePaintInJunctionFaces = 0;
let lanePaintNearJunctionFaces = 0;
let lanePaintOnJunctionSurfaces = 0;
let zebraInsideJunctionFaces = 0;
let zebraOnJunctionSurfaces = 0;
let stopInsideJunctionFaces = 0;
let stopOnJunctionSurfaces = 0;
let approachStopBarTriangles = 0;
let approachStopBarInsideFaces = 0;
const containmentExamples: string[] = [];

function noteContainment(example: string): void {
  if (containmentExamples.length < 20) containmentExamples.push(example);
}

for (const triangle of paintTriangles) {
  const point = triangle.centroid;
  const pointBox: RingBox = { minX: point[0], minY: point[1], maxX: point[0], maxY: point[1] };
  let insideFace: JunctionFace | null = null;
  let nearFace = false;
  for (const face of junctionFaces) {
    if (!boxesOverlap(pointBox, face.box, JUNCTION_PAINT_CLEARANCE_M)) continue;
    if (pointInPolygon(point, face.polygon)) {
      insideFace = face;
      break;
    }
    if (polygonBoundaryDistance(point, face.polygon) < JUNCTION_PAINT_CLEARANCE_M) nearFace = true;
  }
  let onJunctionSurface: JunctionSurface | null = null;
  for (const surface of junctionSurfaces) {
    if (!boxesOverlap(pointBox, surface.box)) continue;
    if (pointInPolygon(point, surface.polygon)) {
      onJunctionSurface = surface;
      break;
    }
  }
  const positionText =
    `${triangle.tile}: ${triangle.family}-paint triangle centroid ` +
    `(${point[0].toFixed(2)}, ${point[1].toFixed(2)})`;

  if (triangle.family === 'lane') {
    if (insideFace) {
      lanePaintInJunctionFaces += 1;
      noteContainment(`${positionText} inside junction face ${insideFace.id} (${insideFace.tile})`);
    } else if (nearFace) {
      lanePaintNearJunctionFaces += 1;
      noteContainment(`${positionText} within 0.45 m of a junction face boundary`);
    }
    if (onJunctionSurface) {
      lanePaintOnJunctionSurfaces += 1;
      noteContainment(`${positionText} on junction surface piece (${onJunctionSurface.tile})`);
    }
  } else if (triangle.family === 'zebra') {
    if (insideFace) {
      zebraInsideJunctionFaces += 1;
      noteContainment(`${positionText} inside junction face ${insideFace.id} (${insideFace.tile})`);
    }
    if (onJunctionSurface) {
      zebraOnJunctionSurfaces += 1;
      noteContainment(`${positionText} on junction surface piece (${onJunctionSurface.tile})`);
    }
  } else {
    // family === 'stop'
    if (isApproachStopBarTriangle(point)) {
      approachStopBarTriangles += 1;
      if (insideFace) approachStopBarInsideFaces += 1;
      continue; // boundary element by contract
    }
    if (insideFace) {
      stopInsideJunctionFaces += 1;
      noteContainment(`${positionText} inside junction face ${insideFace.id} (${insideFace.tile})`);
    }
    if (onJunctionSurface) {
      stopOnJunctionSurfaces += 1;
      noteContainment(`${positionText} on junction surface piece (${onJunctionSurface.tile})`);
    }
  }
}

if (lanePaintInJunctionFaces > 0) {
  violations.push(`${lanePaintInJunctionFaces} lane-paint triangle centroid(s) inside junction faces`);
}
if (lanePaintNearJunctionFaces > 0) {
  violations.push(
    `${lanePaintNearJunctionFaces} lane-paint triangle centroid(s) within ${JUNCTION_PAINT_CLEARANCE_M} m ` +
      'of a junction face boundary',
  );
}
if (lanePaintOnJunctionSurfaces > 0) {
  violations.push(`${lanePaintOnJunctionSurfaces} lane-paint triangle centroid(s) on junction surface pieces`);
}
if (zebraInsideJunctionFaces > 0) {
  violations.push(`${zebraInsideJunctionFaces} zebra-paint triangle centroid(s) inside junction faces`);
}
if (zebraOnJunctionSurfaces > 0) {
  violations.push(`${zebraOnJunctionSurfaces} zebra-paint triangle centroid(s) on junction surface pieces`);
}
if (stopInsideJunctionFaces > 0) {
  violations.push(
    `${stopInsideJunctionFaces} crossing/stop-line triangle centroid(s) inside junction faces ` +
      '(excluding authoritative approach stop bars)',
  );
}
if (stopOnJunctionSurfaces > 0) {
  violations.push(
    `${stopOnJunctionSurfaces} crossing/stop-line triangle centroid(s) on junction surface pieces`,
  );
}

// ---------------------------------------------------------------------------
// 5) tram rails near/through the Ulyanovskaya x Lenina junction area: no lane
//    metadata, continuous across the junction, never used as lane-paint source
// ---------------------------------------------------------------------------

// Junction records are clipped per tile, so a junction can be represented by
// several face fragments (same id) in neighbouring tiles. All fragments near the
// target junction take part in the tram continuity test.
const facesNearTarget = junctionFaces
  .map((face) => ({
    face,
    distance: Math.hypot(
      (face.box.minX + face.box.maxX) / 2 - ULYANOVSKAYA_LENINA.x,
      (face.box.minY + face.box.maxY) / 2 - ULYANOVSKAYA_LENINA.y,
    ),
  }))
  .filter((entry) => entry.distance <= 80)
  .sort((a, b) => a.distance - b.distance);
const junctionNearTarget = facesNearTarget[0];
const tramJunctionIds = new Set(facesNearTarget.map((entry) => entry.face.id));
const tramFaces = junctionFaces.filter((face) => tramJunctionIds.has(face.id));

/** 0 inside any face; otherwise the nearest face boundary distance. */
function pointToFacesDistance(point: [number, number], faces: readonly JunctionFace[]): number {
  let best = Infinity;
  const pointBox: RingBox = { minX: point[0], minY: point[1], maxX: point[0], maxY: point[1] };
  for (const face of faces) {
    if (!boxesOverlap(pointBox, face.box, 10)) continue;
    if (pointInPolygon(point, face.polygon)) return 0;
    const distance = polygonBoundaryDistance(point, face.polygon);
    if (distance < best) best = distance;
  }
  return best;
}

/** Polyline arc length from the first sample up to `index` (metres). */
function arcLengthTo(samples: readonly [number, number][], index: number): number {
  let length = 0;
  for (let i = 1; i <= index; i += 1) {
    length += Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]);
  }
  return length;
}

interface RailJunctionInfo {
  rail: RailRecord;
  distanceToFace: number;
  continuousAcrossArea: boolean;
  lengthBefore: number;
  lengthAfter: number;
}

const railJunctionInfos: RailJunctionInfo[] = [];
let closestRailDistance = Infinity;
if (tramFaces.length > 0 && junctionNearTarget) {
  for (const rail of railRecords) {
    if (!boxesOverlap(ringBBox(rail.centreline as Ring), {
      minX: junctionNearTarget.face.box.minX - 30,
      minY: junctionNearTarget.face.box.minY - 30,
      maxX: junctionNearTarget.face.box.maxX + 30,
      maxY: junctionNearTarget.face.box.maxY + 30,
    })) continue;
    const samples = samplePolyline(rail.centreline, 1.0);
    let bestDistance = Infinity;
    let bestIndex = -1;
    for (let index = 0; index < samples.length; index += 1) {
      const distance = pointToFacesDistance(samples[index], tramFaces);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    closestRailDistance = Math.min(closestRailDistance, bestDistance);
    if (bestIndex < 0 || bestDistance > 10) continue;
    const lengthBefore = arcLengthTo(samples, bestIndex);
    const lengthAfter = arcLengthTo(samples, samples.length - 1) - lengthBefore;
    // Continuity across the junction area: the rail runs through the
    // neighbourhood rather than ending inside it (>=15 m of track on each side
    // of the closest approach).
    const continuousAcrossArea = lengthBefore >= 15 && lengthAfter >= 15;
    railJunctionInfos.push({
      rail,
      distanceToFace: bestDistance,
      continuousAcrossArea,
      lengthBefore,
      lengthAfter,
    });
  }
}
const railNearTramJunction = railJunctionInfos.length;
const railContinuousAcrossJunction = railJunctionInfos.some((info) => info.continuousAcrossArea);

if (!junctionNearTarget) {
  violations.push('no junction face with a polygon found near Ulyanovskaya x Lenina (289,-719)');
} else if (railNearTramJunction === 0) {
  violations.push(
    `no tram rail centreline passes within 10 m of the Ulyanovskaya x Lenina junction area ` +
      `(${tramFaces.length} face fragment(s) checked)`,
  );
} else if (!railContinuousAcrossJunction) {
  violations.push(
    `tram rails near the Ulyanovskaya x Lenina junction are not continuous across the junction area ` +
      `(nearest rail ${closestRailDistance.toFixed(1)} m from the face; need >=15 m of track on both sides)`,
  );
}
if (railRecords.length === 0) violations.push('no kind=rail network pieces in the payload');

for (const rail of railRecords) {
  const piece = rail.piece;
  if (piece.lanes !== undefined || piece.lanesForward !== undefined || piece.lanesBackward !== undefined) {
    violations.push(`${rail.label}: rail piece carries lane counts`);
  }
  const layout = laneMarkingLayout(piece);
  if (layout.some((line) => line.kind === 'centre' || line.kind === 'divider')) {
    violations.push(`${rail.label}: rail piece produced centre/divider lane paint`);
  }
}

// ---------------------------------------------------------------------------
// 6) report
// ---------------------------------------------------------------------------

interface PlaceSummary {
  place: string;
  pieces: number;
  checkedCentrePieces: number;
  checkedDividerPieces: number;
  expectedCentre: number;
  actualCentre: number;
  expectedDividers: number;
  actualDividers: number;
  violations: number;
}

function summarizePlace(place: string): PlaceSummary {
  const records = layoutRecords.filter((record) => record.places.includes(place));
  const centreRecords = records.filter((record) => record.checkedCentre);
  const dividerRecords = records.filter((record) => record.checkedDividers);
  return {
    place,
    pieces: records.length,
    checkedCentrePieces: centreRecords.length,
    checkedDividerPieces: dividerRecords.length,
    expectedCentre: centreRecords.reduce((sum, record) => sum + record.expectedCentre, 0),
    actualCentre: centreRecords.reduce((sum, record) => sum + record.actualCentre, 0),
    expectedDividers: dividerRecords.reduce((sum, record) => sum + record.expectedDividers, 0),
    actualDividers: dividerRecords.reduce((sum, record) => sum + record.actualDividers, 0),
    violations: records.filter((record) => record.problems.length > 0).length,
  };
}

const placeSummaries = [
  summarizePlace('Ulyanovskaya x Lenina'),
  summarizePlace('Independence corridor'),
  summarizePlace('Lenina 1+2'),
];

const ulyanovskayaPlace = placeSummaries[0];
const leninaPlace = placeSummaries[2];
if (ulyanovskayaPlace.pieces === 0) {
  violations.push('no road pieces found near the Ulyanovskaya x Lenina junction target (289,-719)');
}
if (leninaPlace.pieces === 0) {
  violations.push(
    'no Lenina pieces with the asymmetric 1+2 lane signature found near (240,-690) — lane metadata ' +
      'does not expose the user-reported 1+2 segment',
  );
}

const totalLanePaint = paintTriangles.filter((triangle) => triangle.family === 'lane').length;
const totalZebraPaint = paintTriangles.filter((triangle) => triangle.family === 'zebra').length;
const totalStopPaint = paintTriangles.filter((triangle) => triangle.family === 'stop').length;
const totalRailTriangles = tileSummaries.reduce((sum, tile) => sum + tile.railTriangles, 0);
const totalLayoutChecked = tileSummaries.reduce((sum, tile) => sum + tile.layoutChecked, 0);
const totalLayoutViolations = tileSummaries.reduce((sum, tile) => sum + tile.layoutViolations, 0);
const fallbackFaces = junctionFaces.filter((face) => face.fallback).length;

const stats = {
  manifestVersion: manifest.version,
  tiles: tiles.length,
  paintTriangles: {
    lane: totalLanePaint,
    zebra: totalZebraPaint,
    stopLine: totalStopPaint,
    approachStopBars: approachStopBarTriangles,
    approachStopBarsOnFaceBoundary: approachStopBarInsideFaces,
  },
  junctionFaces: junctionFaces.length,
  uniqueJunctionIds: seenJunctionIds.size,
  junctionFallbackFaces: fallbackFaces,
  junctionSurfaces: junctionSurfaces.length,
  laneLayoutPiecesChecked: totalLayoutChecked,
  laneLayoutViolations: totalLayoutViolations,
  lanePaintInJunctionFaces,
  lanePaintNearJunctionFaces,
  lanePaintOnJunctionSurfaces,
  zebraInsideJunctionFaces,
  zebraOnJunctionSurfaces,
  stopInsideJunctionFaces,
  stopOnJunctionSurfaces,
  railPieces: railRecords.length,
  railTriangles: totalRailTriangles,
  railNearTramJunction,
  railClosestDistanceToTramJunction: Number.isFinite(closestRailDistance)
    ? Number(closestRailDistance.toFixed(2))
    : null,
  railContinuousAcrossJunction,
  tramJunctionFaceFragments: tramFaces.length,
  places: placeSummaries,
};

console.log(`Road paint audit — payload ${manifest.version}, ${tiles.length} tiles`);
console.log(
  `  paint triangles: lane=${totalLanePaint}, zebra=${totalZebraPaint}, stop/crossing=${totalStopPaint} ` +
    `(approach stop bars=${approachStopBarTriangles}, of which on a face boundary=${approachStopBarInsideFaces}); ` +
    `junction faces=${junctionFaces.length} (unique ${seenJunctionIds.size}, fallback ${fallbackFaces}); ` +
    `junction surface pieces=${junctionSurfaces.length}`,
);
console.log(
  `  lane paint containment: inside faces=${lanePaintInJunctionFaces}, ` +
    `within ${JUNCTION_PAINT_CLEARANCE_M} m=${lanePaintNearJunctionFaces}, ` +
    `on junction surfaces=${lanePaintOnJunctionSurfaces}`,
);
console.log(
  `  zebra containment: inside faces=${zebraInsideJunctionFaces}, on junction surfaces=${zebraOnJunctionSurfaces}; ` +
    `crossing/stop containment (non-approach): inside faces=${stopInsideJunctionFaces}, ` +
    `on junction surfaces=${stopOnJunctionSurfaces}`,
);
console.log(
  `  lane layout: ${totalLayoutChecked} piece(s) checked, ${totalLayoutViolations} violation(s)`,
);
console.log(
  `  rails: ${railRecords.length} piece(s), ${totalRailTriangles} triangle(s); ` +
    `${railNearTramJunction} within 10 m of the tram junction` +
    `, closest ${Number.isFinite(closestRailDistance) ? closestRailDistance.toFixed(1) : '?'} m` +
    `, continuous across junction area=${railContinuousAcrossJunction}`,
);
if (junctionNearTarget) {
  const face = junctionNearTarget.face;
  console.log(
    `  tram junction: id=${face.id} tile=${face.tile} centre≈(${((face.box.minX + face.box.maxX) / 2).toFixed(1)},` +
      `${((face.box.minY + face.box.maxY) / 2).toFixed(1)}) area=${face.area.toFixed(1)} m² ` +
      `approaches=${face.approaches} approachEdges=${face.approachEdges} fallback=${face.fallback} ` +
      `fragments=${tramFaces.length} (distance to target ${junctionNearTarget.distance.toFixed(1)} m)`,
  );
}
console.log('\nPer-place summary:');
for (const place of placeSummaries) {
  console.log(
    `  ${place.place}: pieces=${place.pieces}, centre=${place.actualCentre}/${place.expectedCentre} ` +
      `(actual/expected, ${place.checkedCentrePieces} checked), ` +
      `dividers=${place.actualDividers}/${place.expectedDividers} ` +
      `(${place.checkedDividerPieces} checked), violations=${place.violations}`,
  );
}
console.log('\nPer-tile:');
for (const tile of tileSummaries) {
  console.log(
    `  ${tile.tile.padEnd(5)} paint=${String(tile.lanePaint).padStart(4)} ` +
      `junctionFaces=${String(tile.junctionFaces).padStart(2)} rail=${tile.railPieces}/${tile.railTriangles}tris ` +
      `layout=${tile.layoutChecked}${tile.layoutViolations ? ` VIOL=${tile.layoutViolations}` : ''}`,
  );
}

if (containmentExamples.length > 0) {
  console.log('\nPaint containment examples:');
  for (const example of containmentExamples) console.log('  - ' + example);
}

mkdirSync('screenshots', { recursive: true });
writeFileSync(
  'screenshots/road-paint-audit.json',
  JSON.stringify({ stats, violations, placeSummaries, tileSummaries }, null, 1),
);

if (violations.length > 0) {
  console.log(`\nROAD PAINT AUDIT FAILED (${violations.length} issue(s)):`);
  for (const issue of violations.slice(0, 60)) console.log('  - ' + issue);
  if (violations.length > 60) console.log(`  … and ${violations.length - 60} more`);
  process.exitCode = 1;
} else {
  console.log('\nROAD PAINT AUDIT PASSED');
}
