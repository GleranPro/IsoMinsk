/**
 * Reusable facade detail geometry (projections, balconies, entrances).
 *
 * Every module writes into the shared `MeshSink` (one merged tile mesh, one draw
 * call) and follows the same rules:
 *  - explicit outward normals in world space (`world = (localX, height, -localY)`),
 *  - metric UVs (`u` along the wall in metres, `v` absolute metres above the
 *    ground volume's base),
 *  - closed manifold solids: each box emits front/back/sides/top/bottom, so no
 *    face can be seen from behind,
 *  - projections stay within `sourceAABB expanded by 0.45 m` (design §8),
 *  - never a coplanar duplicate of the base wall (every projection is proud of
 *    the wall by at least `MIN_PROJECTION_M`),
 *  - the host recipe's palette (`style.baseColor` / `style.trimColor`), never an
 *    independent concrete colour.
 *
 * The modules are intentionally small and bounded: a module either places a
 * finite number of solids on an eligible edge or returns without touching the
 * sink. Callers catch a throw and drop only that module.
 */

import { FACE_KIND } from '../../shared/geometry';
import type { BuildingVolume } from '../../shared/types';
import type { MeshSink, RGB } from './meshSink';
import { makeSurface, type BuildingStyle } from './style';
import type { RingInfo } from './walls';
import { boundaryNormalLocal } from './walls';
import { signedArea, type Point2 } from './polygon2d';

/** Maximum outward projection any module may add (design §8 tolerance). */
export const MAX_PROJECTION_M = 0.45;
/** Minimum outward projection so a detail is never coplanar with the wall. */
export const MIN_PROJECTION_M = 0.06;
/** Balcony slab projection, metres (inside MAX_PROJECTION_M). */
const BALCONY_DEPTH_M = 0.42;
/** Balcony slab thickness, metres. */
const BALCONY_SLAB_M = 0.16;
/** Balcony rail height above the slab, metres. */
const BALCONY_RAIL_M = 0.92;
/** Entrance canopy projection, metres. */
const CANOPY_DEPTH_M = 0.42;
/** Entrance canopy thickness, metres. */
const CANOPY_THICKNESS_M = 0.2;
/** Pier projection for the facade frame, metres. */
const PIER_DEPTH_M = 0.16;
/** Cornice / plinth projection, metres. */
const BAND_DEPTH_M = 0.22;
/** Minimum edge length that can host a module (metres). */
const MIN_EDGE_M = 2.4;

export interface FacadeDetailContext {
  /** Cleaned rings of the volume (exterior first, holes after). */
  readonly rings: readonly RingInfo[];
  /** Volume being detailed (source metadata: base height, wall top). */
  readonly volume: BuildingVolume;
  /** Source AABB of the whole building, expanded by the projection tolerance. */
  readonly allowedBounds?: readonly [number, number, number, number];
  /** Floor height / ground floor height resolved from the recipe preset. */
  readonly floorHeight: number;
  readonly groundFloorHeight: number;
  /** Window bay width resolved from the recipe preset. */
  readonly bayWidth: number;
  /** Emit geometry at all (facadeDetail flag). */
  readonly detail: boolean;
}

interface Edge {
  readonly ring: RingInfo;
  readonly index: number;
  readonly p0: Point2;
  readonly p1: Point2;
  readonly length: number;
  /** Outward unit normal in local plan (x, y). */
  readonly nx: number;
  readonly ny: number;
}

/** Enumerate the straight boundary edges long enough to host a module. */
export function facadeEdges(rings: readonly RingInfo[], minLength = MIN_EDGE_M): Edge[] {
  const edges: Edge[] = [];
  for (const ring of rings) {
    const points = ring.points;
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % n];
      const dx = p1[0] - p0[0];
      const dy = p1[1] - p0[1];
      const length = Math.hypot(dx, dy);
      if (!(length >= minLength)) continue;
      const [nx, ny] = boundaryNormalLocal(ring, i);
      edges.push({ ring, index: i, p0, p1, length, nx, ny });
    }
  }
  return edges;
}

/** Point at parameter t (0..1) along an edge. */
function along(edge: Edge, t: number): Point2 {
  return [edge.p0[0] + (edge.p1[0] - edge.p0[0]) * t, edge.p0[1] + (edge.p1[1] - edge.p0[1]) * t];
}

/** True when a plan point is inside the allowed bounds (if provided). */
function withinBounds(
  x: number,
  y: number,
  bounds: readonly [number, number, number, number] | undefined,
): boolean {
  if (!bounds) return true;
  return x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3];
}

/**
 * Emit one closed box standing on the plan quad `corners` (perimeter order,
 * either winding) between `h0` and `h1`.
 */
export function addBox(
  sink: MeshSink,
  style: BuildingStyle,
  corners: readonly Point2[],
  h0: number,
  h1: number,
  kind: number,
  color: RGB,
  baseHeight: number,
): void {
  if (corners.length !== 4) return;
  if (!(h1 - h0 > 1e-4)) return;
  const top = Math.max(h0, Math.min(h1, Number.isFinite(h1) ? h1 : h0));
  if (!(top - h0 > 1e-4)) return;
  const surface = makeSurface(style, kind, color, style.detailScale);
  const area = signedArea(corners as Point2[]);
  if (Math.abs(area) < 1e-6) return;
  // Normalise winding to CCW in local plan so the right-hand normal points out.
  const ordered = area > 0 ? corners : [...corners].reverse();
  const uOrigin = ordered[0];
  let uCursor = 0;
  for (let i = 0; i < 4; i++) {
    const a = ordered[i];
    const b = ordered[(i + 1) % 4];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const nx = dy / len;
    const ny = -dx / len;
    const u0 = uCursor;
    const u1 = uCursor + len;
    uCursor = u1;
    sink.addQuad(
      a[0],
      h0,
      -a[1],
      b[0],
      h0,
      -b[1],
      b[0],
      top,
      -b[1],
      a[0],
      top,
      -a[1],
      u0,
      h0 - baseHeight,
      u1,
      h0 - baseHeight,
      u1,
      top - baseHeight,
      u0,
      top - baseHeight,
      nx,
      0,
      -ny,
      surface,
    );
  }
  // Top and bottom caps (closed manifold).
  const vTop = top - baseHeight;
  const vBottom = h0 - baseHeight;
  sink.addQuad(
    ordered[0][0],
    top,
    -ordered[0][1],
    ordered[1][0],
    top,
    -ordered[1][1],
    ordered[2][0],
    top,
    -ordered[2][1],
    ordered[3][0],
    top,
    -ordered[3][1],
    0,
    vTop,
    1,
    vTop,
    2,
    vTop,
    3,
    vTop,
    0,
    1,
    0,
    surface,
  );
  sink.addQuad(
    ordered[0][0],
    h0,
    -ordered[0][1],
    ordered[3][0],
    h0,
    -ordered[3][1],
    ordered[2][0],
    h0,
    -ordered[2][1],
    ordered[1][0],
    h0,
    -ordered[1][1],
    0,
    vBottom,
    1,
    vBottom,
    2,
    vBottom,
    3,
    vBottom,
    0,
    -1,
    0,
    surface,
  );
  void uOrigin;
}

/**
 * A rectangular solid that projects outward from a wall edge.
 *
 * `from`/`to` are parameters along the edge; `depth` is the outward projection.
 * Returns false when the projection would leave the allowed bounds.
 */
function addWallBox(
  sink: MeshSink,
  style: BuildingStyle,
  edge: Edge,
  from: number,
  to: number,
  depth: number,
  h0: number,
  h1: number,
  kind: number,
  color: RGB,
  baseHeight: number,
  bounds: readonly [number, number, number, number] | undefined,
): boolean {
  const d = Math.max(MIN_PROJECTION_M, Math.min(MAX_PROJECTION_M, depth));
  const a = along(edge, from);
  const b = along(edge, to);
  const outA: Point2 = [a[0] + edge.nx * d, a[1] + edge.ny * d];
  const outB: Point2 = [b[0] + edge.nx * d, b[1] + edge.ny * d];
  for (const point of [outA, outB]) {
    if (!withinBounds(point[0], point[1], bounds)) return false;
  }
  addBox(sink, style, [a, b, outB, outA], h0, h1, kind, color, baseHeight);
  return true;
}

/**
 * Facade frame: projecting piers at bay intervals plus a plinth band and a
 * cornice band. Follows the real edge coordinates, so it lines up with the
 * painted window rows of the same recipe.
 */
export function addFacadeFrame(
  sink: MeshSink,
  style: BuildingStyle,
  context: FacadeDetailContext,
  options: { piers?: boolean; plinth?: boolean; cornice?: boolean } = {},
): number {
  if (!context.detail || style.motif === 'legacy') return 0;
  const piers = options.piers !== false;
  const plinth = options.plinth !== false;
  const cornice = options.cornice !== false;
  const base = context.volume.minHeight;
  const wallTop = context.volume.height;
  const wallHeight = wallTop - base;
  if (!(wallHeight > 3)) return 0;
  const bay = Math.max(1.6, context.bayWidth);
  const trimColor = style.trimColor;
  let emitted = 0;
  const edges = facadeEdges(context.rings);
  for (const edge of edges) {
    if (plinth && wallHeight > context.groundFloorHeight + 0.6) {
      if (
        addWallBox(
          sink,
          style,
          edge,
          0,
          1,
          BAND_DEPTH_M * 0.5,
          base,
          base + Math.min(0.9, context.groundFloorHeight * 0.4),
          FACE_KIND.trim,
          trimColor,
          base,
          context.allowedBounds,
        )
      ) {
        emitted++;
      }
    }
    if (cornice && style.trimIntensity > 0.05) {
      const bandHeight = Math.min(1.2, Math.max(0.24, style.trimIntensity * 0.9));
      if (
        addWallBox(
          sink,
          style,
          edge,
          0,
          1,
          BAND_DEPTH_M,
          wallTop - bandHeight,
          wallTop,
          FACE_KIND.trim,
          trimColor,
          base,
          context.allowedBounds,
        )
      ) {
        emitted++;
      }
    }
    if (!piers) continue;
    const bays = Math.floor(edge.length / bay);
    if (bays < 1) continue;
    const pierWidth = Math.min(0.62, Math.max(0.28, bay * 0.16));
    for (let bayIndex = 0; bayIndex <= bays; bayIndex++) {
      const t = (bayIndex * bay) / edge.length;
      const half = pierWidth / edge.length / 2;
      const from = Math.max(0, t - half);
      const to = Math.min(1, t + half);
      if (!(to - from > 0)) continue;
      if (
        addWallBox(
          sink,
          style,
          edge,
          from,
          to,
          PIER_DEPTH_M,
          base + context.groundFloorHeight,
          wallTop - 0.25,
          FACE_KIND.trim,
          trimColor,
          base,
          context.allowedBounds,
        )
      ) {
        emitted++;
      }
    }
  }
  return emitted;
}

/**
 * Balcony stack: floor-aligned slabs and rails on contiguous whole bays of the
 * longest eligible edges. The rail top is clamped to the wall top and every
 * projection stays inside the allowed bounds.
 */
export function addBalconyStack(
  sink: MeshSink,
  style: BuildingStyle,
  context: FacadeDetailContext,
): number {
  if (!context.detail || style.motif === 'legacy') return 0;
  const base = context.volume.minHeight;
  const wallTop = context.volume.height;
  const wallHeight = wallTop - base;
  const floor = Math.max(2.4, context.floorHeight);
  const ground = Math.max(2.0, context.groundFloorHeight);
  if (!(wallHeight > ground + floor * 0.8)) return 0;
  const bay = Math.max(1.8, context.bayWidth);
  const edges = facadeEdges(context.rings, bay * 1.5).sort((a, b) => b.length - a.length);
  if (!edges.length) return 0;
  const edge = edges[0];
  const bays = Math.floor(edge.length / bay);
  if (bays < 1) return 0;
  // Contiguous whole-bay run, deterministic per building.
  const runBays = Math.min(bays, 1 + (Math.floor(style.seed * 2.999) % 2));
  const startBay = Math.floor(style.seed * 97) % Math.max(1, bays - runBays + 1);
  const from = (startBay * bay) / edge.length;
  const to = ((startBay + runBays) * bay) / edge.length;
  const slabColor = style.trimColor;
  const railColor: RGB = [
    Math.max(0, style.baseColor[0] * 0.9),
    Math.max(0, style.baseColor[1] * 0.9),
    Math.max(0, style.baseColor[2] * 0.9),
  ];
  let emitted = 0;
  const floors = Math.floor((wallHeight - ground) / floor);
  for (let level = 0; level < floors; level++) {
    if (level % 2 === 1) continue; // alternating balcony stacks
    const slabBottom = base + ground + level * floor;
    const slabTop = slabBottom + BALCONY_SLAB_M;
    if (slabTop >= wallTop - 0.4) break;
    if (
      addWallBox(
        sink,
        style,
        edge,
        from,
        to,
        BALCONY_DEPTH_M,
        slabBottom,
        slabTop,
        FACE_KIND.trim,
        slabColor,
        base,
        context.allowedBounds,
      )
    ) {
      emitted++;
    }
    const railTop = Math.min(wallTop, slabTop + BALCONY_RAIL_M);
    if (railTop - slabTop > 0.2) {
      // The rail sits at the outer edge of the slab, not on the wall plane.
      const a = along(edge, from);
      const b = along(edge, to);
      const outA: Point2 = [a[0] + edge.nx * BALCONY_DEPTH_M, a[1] + edge.ny * BALCONY_DEPTH_M];
      const outB: Point2 = [b[0] + edge.nx * BALCONY_DEPTH_M, b[1] + edge.ny * BALCONY_DEPTH_M];
      if (withinBounds(outA[0], outA[1], context.allowedBounds) && withinBounds(outB[0], outB[1], context.allowedBounds)) {
        addBox(sink, style, [outA, outB, b, a], slabTop, railTop, FACE_KIND.trim, railColor, base);
        emitted++;
      }
    }
  }
  return emitted;
}

/**
 * Entrance treatment on the longest eligible edge: a glazed door panel and a
 * canopy, both bounded below `min(groundFloorHeight, wallHeight)`.
 *
 * A building whose wall is at most one ground floor tall gets only the scaled
 * door treatment — never an outside second storey.
 */
export function addEntranceTreatment(
  sink: MeshSink,
  style: BuildingStyle,
  context: FacadeDetailContext,
): number {
  if (!context.detail || style.motif === 'legacy') return 0;
  const base = context.volume.minHeight;
  const wallTop = context.volume.height;
  const wallHeight = wallTop - base;
  const ground = Math.min(context.groundFloorHeight, wallHeight);
  if (!(wallHeight >= 2.4)) return 0;
  const bay = Math.max(1.8, context.bayWidth);
  const edges = facadeEdges(context.rings, bay).sort((a, b) => b.length - a.length);
  if (!edges.length) return 0;
  const edge = edges[0];
  const bays = Math.floor(edge.length / bay);
  if (bays < 1) return 0;
  const startBay = Math.floor(style.seed * 61) % Math.max(1, bays);
  const from = (startBay * bay) / edge.length;
  const to = Math.min(1, ((startBay + 1) * bay) / edge.length);
  const doorWidth = Math.min(0.36, (bay * 0.55) / edge.length);
  const centre = (from + to) / 2;
  const doorFrom = Math.max(0, centre - doorWidth / 2);
  const doorTo = Math.min(1, centre + doorWidth / 2);
  const doorHeight = Math.min(2.4, ground - 0.35);
  let emitted = 0;
  if (doorHeight > 1.2 && doorTo > doorFrom) {
    if (
      addWallBox(
        sink,
        style,
        edge,
        doorFrom,
        doorTo,
        MIN_PROJECTION_M,
        base,
        base + doorHeight,
        FACE_KIND.glass,
        style.baseColor,
        base,
        context.allowedBounds,
      )
    ) {
      emitted++;
    }
  }
  const canopyHeight = Math.min(ground - 0.25, wallHeight - 0.4);
  if (canopyHeight > 2.2 && wallHeight > ground + 0.4) {
    const canopyFrom = Math.max(0, centre - (bay * 0.7) / edge.length);
    const canopyTo = Math.min(1, centre + (bay * 0.7) / edge.length);
    if (
      addWallBox(
        sink,
        style,
        edge,
        canopyFrom,
        canopyTo,
        CANOPY_DEPTH_M,
        base + canopyHeight,
        base + canopyHeight + CANOPY_THICKNESS_M,
        FACE_KIND.trim,
        style.trimColor,
        base,
        context.allowedBounds,
      )
    ) {
      emitted++;
    }
  }
  return emitted;
}

/**
 * Roof service housings on a sufficiently large flat roof: a bounded number of
 * small boxes, kept away from the roof edges so they cannot float over a street.
 */
export function addRoofService(
  sink: MeshSink,
  style: BuildingStyle,
  context: FacadeDetailContext,
): number {
  if (!context.detail || style.motif === 'legacy') return 0;
  if (context.volume.roofShape !== 'flat') return 0;
  const rings = context.rings;
  if (rings.length !== 1) return 0;
  const points = rings[0].points;
  if (points.length < 4) return 0;
  // Axis-aligned AABB of the roof: only place housings well inside it.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const width = maxX - minX;
  const depth = maxY - minY;
  if (!(width > 14) || !(depth > 10)) return 0;
  const count = width > 30 ? 2 : 1;
  const size = Math.min(2.4, Math.max(1.0, width * 0.05));
  const top = context.volume.height;
  let emitted = 0;
  for (let i = 0; i < count; i++) {
    const cx = minX + width * (0.35 + 0.3 * i);
    const cy = minY + depth * (i % 2 === 0 ? 0.35 : 0.65);
    const halfW = size / 2;
    const halfD = size / 2;
    const corners: Point2[] = [
      [cx - halfW, cy - halfD],
      [cx + halfW, cy - halfD],
      [cx + halfW, cy + halfD],
      [cx - halfW, cy + halfD],
    ];
    addBox(sink, style, corners, top, top + 0.9, FACE_KIND.trim, style.trimColor, context.volume.minHeight);
    emitted++;
  }
  return emitted;
}

/** Plan-space AABB of a volume's rings. */
export function ringsBounds(rings: readonly RingInfo[]): [number, number, number, number] | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring.points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return undefined;
  return [minX, minY, maxX, maxY];
}

/** Expand a plan AABB by the approved projection tolerance. */
export function expandBounds(
  bounds: readonly [number, number, number, number],
  allowance = MAX_PROJECTION_M,
): [number, number, number, number] {
  return [bounds[0] - allowance, bounds[1] - allowance, bounds[2] + allowance, bounds[3] + allowance];
}
