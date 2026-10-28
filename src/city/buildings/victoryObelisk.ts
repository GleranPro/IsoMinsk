/**
 * Victory Monument obelisk (Монумент Победы, Victory Square) — landmark geometry.
 *
 * OSM: building way 346312699, a 16x16 m footprint (a chamfered square stylobate)
 * with a bogus height=4 plus `building:part` volumes for the pedestal (11 m) and
 * the pyramidion (38 m). The real monument is a stepped granite pedestal, a tall
 * tapering four-sided obelisk shaft with bronze relief bands, a stone pyramidion
 * and a gold Order-of-Victory star on top; the eternal flame burns on a slab in
 * front of the pedestal.
 *
 * Proportions are taken from the user's earlier Minsk Landmarks model
 * (`tools/blender/build_victory_sq.py`): star above 36.8 m, pyramidion
 * 36.1-36.7 m, pedestal top 0.73 m. The rendered target is ~38 m total.
 *
 * This module replaces the generic extrusion completely (curated landmark): it
 * emits the WHOLE massing — steps, shaft, bands, pyramidion, star and flame.
 * Geometry is fully deterministic (no Math.random, no THREE objects): only
 * MeshSink.addQuad/addTriangle and plain number arrays.
 *
 * Units: metres. Local plan coords (x east, y north) map to world space as
 * (x, height, -y), exactly like the rest of the building builder.
 * aUV: u = metres along the face, v = height above the monument base.
 */

import { FACE_KIND, ROOF_SHAPE_ID, STYLE_FLAG } from '../../shared/geometry';
import type { BuildingFeature } from '../../shared/types';
import type { MeshSink, SurfaceStyle } from './meshSink';
import { offsetRing } from './palaceAccents';
import {
  cleanRing,
  minAreaRect,
  signedArea,
  triangleSignedArea,
  type Point2,
} from './polygon2d';
import { srgbFromHex, type BuildingStyle } from './style';
import { triangulatePolygon } from './triangulate';
import { boundaryNormalLocal, type RingInfo } from './walls';

/** Shared landmark id (src/shared/types.ts `LandmarkId`). */
const VICTORY_OBELISK_LANDMARK = 'victory-obelisk';

// --- palette (sRGB, linearised by the facade shader) -----------------------
const GRANITE = srgbFromHex('#8A8B86'); // main granite mass
const PLINTH = srgbFromHex('#6E6F6B'); // darker granite plinth / base step
const BRONZE = srgbFromHex('#8A7333'); // bronze relief bands
const GOLD = srgbFromHex('#D4AF37'); // Order-of-Victory star
const FLAME = srgbFromHex('#E07A1F'); // eternal flame body
const FLAME_CORE = srgbFromHex('#F5C24B'); // flame hot core

// --- measured module constants (metres) -----------------------------------
/** Height of each pedestal step block. */
const STEP_HEIGHT = 1.2;
/** Number of stepped pedestal blocks (16x16 -> ~12x12 -> ~8.8x8.8). */
const STEP_COUNT = 3;
/** Each pedestal step is inset this much from the one below it. */
const STEP_INSET = 1.8;
/** Base of the tapering obelisk shaft (top of the pedestal). */
const SHAFT_BASE_Y = STEP_HEIGHT * STEP_COUNT; // 3.6 m
/** Top of the tapering obelisk shaft (base of the pyramidion). */
const SHAFT_TOP_Y = 35.5;
/** Half width of the square shaft section at its base (5.6 x 5.6 m). */
const SHAFT_BASE_HALF = 2.8;
/** Half width of the square shaft section at its top (2.2 x 2.2 m). */
const SHAFT_TOP_HALF = 1.1;
/** Apex of the stone pyramidion above the shaft. */
const PYRAMIDION_TOP_Y = 37.2;
/** Centre of the gold star finial (top of the monument = 37.6 + 0.6 = 38.2 m). */
const STAR_CENTER_Y = 37.6;
/** Half height of the octahedral star finial. */
const STAR_HALF_HEIGHT = 0.6;
/** Horizontal radius of the star finial. */
const STAR_RADIUS = 0.95;
/** Bronze relief bands sit at these fractions of the shaft height. */
const BAND_FRACTIONS: readonly number[] = [1 / 3, 2 / 3];
/** Height of one bronze relief band. */
const BAND_HEIGHT = 0.8;
/** The relief band stands this far proud of the shaft face. */
const BAND_OUTSET = 0.16;
/** Eternal-flame slab distance in front of the base step. */
const FLAME_GAP = 2.6;
/** Eternal-flame slab dimensions. */
const FLAME_SLAB_HALF_U = 2.6;
const FLAME_SLAB_HALF_V = 2.1;
const FLAME_SLAB_HEIGHT = 0.4;
/** Fallback shaft half width when the generated step rings collapse. */
const MIN_SHAFT_HALF = 1.2;

type Vec3 = [number, number, number];

/** True when the feature is the Victory Square obelisk landmark. */
export function isVictoryObeliskBuilding(building: BuildingFeature): boolean {
  return building?.landmark === VICTORY_OBELISK_LANDMARK;
}

/** Local plan coords (x, y) + height -> world space (x, height, -y). */
function world(x: number, y: number, height: number): Vec3 {
  return [x, height, -y];
}

function ringInfoOf(points: Point2[]): RingInfo {
  const area = signedArea(points);
  return { points, isHole: false, area, ccw: area > 0 };
}

/** Vertex attribute payload for one landmark surface. */
function surface(
  style: BuildingStyle,
  kind: number,
  color: SurfaceStyle['color'],
  extraFlags = 0,
  roofShapeId?: number,
): SurfaceStyle {
  return {
    owner: style.owner,
    color,
    style: style.style,
    face: [kind, style.flags | extraFlags, style.trimIntensity, roofShapeId ?? style.detailScale],
  };
}

function normalize3(x: number, y: number, z: number): Vec3 {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/**
 * Emit one quad with an explicit normal (MeshSink corrects the winding to match
 * the normal) or with the geometric normal of the first three corners.
 */
function emitQuad(
  sink: MeshSink,
  corners: readonly Vec3[],
  uv: readonly [number, number][],
  style: SurfaceStyle,
  normal?: Vec3,
): void {
  if (corners.length !== 4 || uv.length !== 4) return;
  let n = normal;
  if (!n) {
    const abx = corners[1][0] - corners[0][0];
    const aby = corners[1][1] - corners[0][1];
    const abz = corners[1][2] - corners[0][2];
    const acx = corners[2][0] - corners[0][0];
    const acy = corners[2][1] - corners[0][1];
    const acz = corners[2][2] - corners[0][2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    if (Math.hypot(nx, ny, nz) < 1e-9) return;
    n = normalize3(nx, ny, nz);
  }
  sink.addQuad(
    corners[0][0], corners[0][1], corners[0][2],
    corners[1][0], corners[1][1], corners[1][2],
    corners[2][0], corners[2][1], corners[2][2],
    corners[3][0], corners[3][1], corners[3][2],
    uv[0][0], uv[0][1], uv[1][0], uv[1][1],
    uv[2][0], uv[2][1], uv[3][0], uv[3][1],
    n[0], n[1], n[2], style,
  );
}

/** Flat, upward-facing polygon deck at constant height. */
function emitDeck(sink: MeshSink, points: readonly Point2[], height: number, style: SurfaceStyle): void {
  const triangulation = triangulatePolygon([points as Point2[]]);
  for (const triangle of triangulation.triangles) {
    const { a, b, c } = triangle;
    const signed = triangleSignedArea(a, b, c);
    if (Math.abs(signed) < 1e-6) continue;
    const wa = world(a[0], a[1], height);
    const wb = world(b[0], b[1], height);
    const wc = world(c[0], c[1], height);
    if (signed > 0) {
      sink.addTriangle(
        wa[0], wa[1], wa[2], wb[0], wb[1], wb[2], wc[0], wc[1], wc[2],
        0, 1, 0,
        a[0], a[1], b[0], b[1], c[0], c[1],
        style,
      );
    } else {
      sink.addTriangle(
        wa[0], wa[1], wa[2], wc[0], wc[1], wc[2], wb[0], wb[1], wb[2],
        0, 1, 0,
        a[0], a[1], c[0], c[1], b[0], b[1],
        style,
      );
    }
  }
}

/** Vertical band of walls around one closed ring (aUV u accumulates along it). */
function emitRingWalls(
  sink: MeshSink,
  ring: RingInfo,
  yBottom: number,
  yTop: number,
  style: SurfaceStyle,
): void {
  const points = ring.points;
  const count = points.length;
  let u = 0;
  for (let i = 0; i < count; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % count];
    const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const u0 = u;
    const u1 = u + length;
    u = u1;
    if (length < 1e-3) continue;
    const [nlx, nly] = boundaryNormalLocal(ring, i);
    emitQuad(
      sink,
      [
        world(p0[0], p0[1], yBottom),
        world(p1[0], p1[1], yBottom),
        world(p1[0], p1[1], yTop),
        world(p0[0], p0[1], yTop),
      ],
      [
        [u0, 0],
        [u1, 0],
        [u1, yTop - yBottom],
        [u0, yTop - yBottom],
      ],
      style,
      [nlx, 0, -nly],
    );
  }
}

/** Square ring (CCW in local metres) from a centre, unit axes and half size. */
function squareRing(centre: Point2, ux: number, uy: number, half: number): Point2[] {
  const vx = -uy;
  const vy = ux;
  const corner = (sx: number, sy: number): Point2 => [
    centre[0] + (ux * sx + vx * sy) * half,
    centre[1] + (uy * sx + vy * sy) * half,
  ];
  return [corner(1, 1), corner(-1, 1), corner(-1, -1), corner(1, -1)];
}

/** Smallest distance from a point to the ring boundary (metres). */
function distanceToRing(points: readonly Point2[], x: number, y: number): number {
  let best = Infinity;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSq = dx * dx + dy * dy;
    let t = 0;
    if (lengthSq > 1e-12) {
      t = ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const d = Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Tapering square prism section (the obelisk shaft / a band ring): four flat
 * faces from `halfBottom` at `yBottom` to `halfTop` at `yTop`.
 */
function emitSquareSection(
  sink: MeshSink,
  centre: Point2,
  ux: number,
  uy: number,
  halfBottom: number,
  halfTop: number,
  yBottom: number,
  yTop: number,
  style: SurfaceStyle,
): void {
  const vx = -uy;
  const vy = ux;
  const corner = (sx: number, sy: number, half: number, height: number): Vec3 => [
    centre[0] + (ux * sx + vx * sy) * half,
    height,
    -(centre[1] + (uy * sx + vy * sy) * half),
  ];
  const offsets: readonly [number, number][] = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  let u = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = offsets[i];
    const [bx, by] = offsets[(i + 1) % 4];
    const a0 = corner(ax, ay, halfBottom, yBottom);
    const b0 = corner(bx, by, halfBottom, yBottom);
    const b1 = corner(bx, by, halfTop, yTop);
    const a1 = corner(ax, ay, halfTop, yTop);
    const edge = Math.hypot(b0[0] - a0[0], b0[2] - a0[2]);
    const u0 = u;
    const u1 = u + edge;
    u = u1;
    if (edge < 1e-3) continue;
    emitQuad(
      sink,
      [a0, b0, b1, a1],
      [
        [u0, yBottom],
        [u1, yBottom],
        [u1, yTop],
        [u0, yTop],
      ],
      style,
    );
  }
}

/** Square pyramid (pyramidion / small cap): base at yBottom, apex at apexY. */
function emitSquarePyramid(
  sink: MeshSink,
  centre: Point2,
  ux: number,
  uy: number,
  half: number,
  yBottom: number,
  apexY: number,
  style: SurfaceStyle,
): void {
  const ring = ringInfoOf(squareRing(centre, ux, uy, half));
  const points = ring.points;
  const apex = world(centre[0], centre[1], apexY);
  const cx = centre[0];
  const cz = -centre[1];
  let u = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const wa = world(a[0], a[1], yBottom);
    const wb = world(b[0], b[1], yBottom);
    const abx = wb[0] - wa[0];
    const aby = wb[1] - wa[1];
    const abz = wb[2] - wa[2];
    const aax = apex[0] - wa[0];
    const aay = apex[1] - wa[1];
    const aaz = apex[2] - wa[2];
    let normal = normalize3(
      aby * aaz - abz * aay,
      abz * aax - abx * aaz,
      abx * aay - aby * aax,
    );
    const centroidX = (wa[0] + wb[0] + apex[0]) / 3 - cx;
    const centroidZ = (wa[2] + wb[2] + apex[2]) / 3 - cz;
    if (centroidX * normal[0] + centroidZ * normal[2] < 0) {
      normal = [-normal[0], -normal[1], -normal[2]];
    }
    const u0 = u;
    const u1 = u + Math.hypot(abx, abz);
    u = u1;
    sink.addTriangle(
      wa[0], wa[1], wa[2], wb[0], wb[1], wb[2], apex[0], apex[1], apex[2],
      normal[0], normal[1], normal[2],
      u0, yBottom, u1, yBottom, (u0 + u1) / 2, apexY,
      style,
    );
  }
}

/** Gold octahedral star (Order of Victory finial): 4 upper + 4 lower faces. */
function emitStar(
  sink: MeshSink,
  centre: Point2,
  centreY: number,
  radius: number,
  halfHeight: number,
  style: SurfaceStyle,
): void {
  const cx = centre[0];
  const cz = -centre[1];
  const top: Vec3 = [cx, centreY + halfHeight, cz];
  const bottom: Vec3 = [cx, centreY - halfHeight, cz];
  const ring: Vec3[] = [];
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    ring.push([cx + Math.cos(angle) * radius, centreY, cz + Math.sin(angle) * radius]);
  }
  const faces: [Vec3, Vec3, Vec3][] = [];
  for (let i = 0; i < 4; i++) {
    faces.push([ring[i], ring[(i + 1) % 4], top]);
    faces.push([ring[(i + 1) % 4], ring[i], bottom]);
  }
  let u = 0;
  for (const [a, b, apex] of faces) {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const ax = apex[0] - a[0];
    const ay = apex[1] - a[1];
    const az = apex[2] - a[2];
    const rawNormal = normalize3(
      aby * az - abz * ay,
      abz * ax - abx * az,
      abx * ay - aby * ax,
    );
    const centroidX = (a[0] + b[0] + apex[0]) / 3 - cx;
    const centroidY = (a[1] + b[1] + apex[1]) / 3 - centreY;
    const centroidZ = (a[2] + b[2] + apex[2]) / 3 - cz;
    const outward =
      centroidX * rawNormal[0] + centroidY * rawNormal[1] + centroidZ * rawNormal[2];
    const normal: Vec3 =
      outward >= 0 ? rawNormal : [-rawNormal[0], -rawNormal[1], -rawNormal[2]];
    sink.addTriangle(
      a[0], a[1], a[2], b[0], b[1], b[2], apex[0], apex[1], apex[2],
      normal[0], normal[1], normal[2],
      u, 0, u + 0.5, 0, u + 0.25, 1,
      style,
    );
    u += 0.5;
  }
}

/** Low slab + flame pyramid for the eternal flame in front of the pedestal. */
function emitEternalFlame(
  sink: MeshSink,
  centre: Point2,
  ux: number,
  uy: number,
  style: BuildingStyle,
): void {
  const vx = -uy;
  const vy = ux;
  const halfU = FLAME_SLAB_HALF_U;
  const halfV = FLAME_SLAB_HALF_V;
  const corner = (su: number, sv: number, height: number): Vec3 => [
    centre[0] + ux * su * halfU + vx * sv * halfV,
    height,
    -(centre[1] + uy * su * halfU + vy * sv * halfV),
  ];
  const slabStyle = surface(style, FACE_KIND.trim, PLINTH, STYLE_FLAG.blank);
  const slabTop = FLAME_SLAB_HEIGHT;
  const slabCorners = [
    corner(1, 1, 0),
    corner(-1, 1, 0),
    corner(-1, -1, 0),
    corner(1, -1, 0),
  ];
  for (let i = 0; i < 4; i++) {
    const a = slabCorners[i];
    const b = slabCorners[(i + 1) % 4];
    emitQuad(
      sink,
      [a, b, [b[0], slabTop, b[2]], [a[0], slabTop, a[2]]],
      [
        [0, 0],
        [1, 0],
        [1, slabTop],
        [0, slabTop],
      ],
      slabStyle,
    );
  }
  // Slab top deck (explicit +Y normal).
  emitQuad(
    sink,
    [
      [slabCorners[0][0], slabTop, slabCorners[0][2]],
      [slabCorners[3][0], slabTop, slabCorners[3][2]],
      [slabCorners[2][0], slabTop, slabCorners[2][2]],
      [slabCorners[1][0], slabTop, slabCorners[1][2]],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    slabStyle,
    [0, 1, 0],
  );

  const flameStyle = surface(style, FACE_KIND.trim, FLAME);
  const coreStyle = surface(style, FACE_KIND.trim, FLAME_CORE);
  // Outer flame body (granite slab top -> 1.8 m) and a hot gold core on top.
  emitSquarePyramid(sink, centre, ux, uy, 1.25, slabTop, slabTop + 1.6, flameStyle);
  emitSquarePyramid(sink, centre, ux, uy, 0.5, slabTop + 1.4, slabTop + 2.3, coreStyle);
}

/** Largest usable volume footprint, used only when `outline` is absent. */
function fallbackOutline(building: BuildingFeature): Point2[] | null {
  const volumes = Array.isArray(building.volumes) ? building.volumes : [];
  let best: Point2[] | null = null;
  let bestArea = 0;
  for (const volume of volumes) {
    const points = cleanRing(volume?.footprint?.[0]);
    if (points.length < 3) continue;
    const area = Math.abs(signedArea(points));
    if (area > bestArea) {
      bestArea = area;
      best = points;
    }
  }
  return best;
}

/**
 * Append the whole Victory obelisk (stepped pedestal, tapering shaft, bronze
 * relief bands, pyramidion, gold star, eternal flame) to the sink.
 *
 * Never throws: data problems are reported through `onWarning`. Falls back to
 * the largest volume footprint when the curated `outline` is missing.
 */
export function addVictoryObelisk(
  sink: MeshSink,
  building: BuildingFeature,
  style: BuildingStyle,
  onWarning?: (message: string) => void,
): void {
  const warn = onWarning ?? (() => {});
  try {
    if (!isVictoryObeliskBuilding(building)) return;

    let basePoints = cleanRing(building.outline?.[0]);
    if (basePoints.length < 3) {
      const fallback = fallbackOutline(building);
      if (!fallback) {
        warn('victory obelisk: no usable outline or volume footprint; landmark skipped');
        return;
      }
      warn('victory obelisk: missing outline; using the largest volume footprint');
      basePoints = fallback;
    }

    const baseRing = ringInfoOf(basePoints);
    if (Math.abs(baseRing.area) < 16) {
      warn(`victory obelisk: footprint area ${Math.abs(baseRing.area).toFixed(1)} m² is too small`);
      return;
    }
    const rect = minAreaRect(basePoints);
    if (!rect) {
      warn('victory obelisk: could not derive the monument axes (degenerate footprint)');
      return;
    }
    const centre: Point2 = [rect.cx, rect.cy];
    const ux = rect.ux;
    const uy = rect.uy;

    // --- stepped granite pedestal -----------------------------------------
    // Step 1 follows the OSM stylobate outline; the inner steps are mitered
    // insets of it (falling back to squares of the monument axes if the inset
    // collapses the ring).
    const stepRings: RingInfo[] = [baseRing];
    for (let i = 1; i < STEP_COUNT; i++) {
      const offsetPoints = offsetRing(baseRing, -STEP_INSET * i);
      const offsetArea = Math.abs(signedArea(offsetPoints));
      const minArea = Math.max(4, Math.abs(baseRing.area) * 0.12);
      if (offsetPoints.length >= 4 && offsetArea >= minArea) {
        stepRings.push(ringInfoOf(offsetPoints));
      } else {
        const fallbackHalf = Math.max(1.6, rect.halfLength - STEP_INSET * (i + 1));
        stepRings.push(ringInfoOf(squareRing(centre, ux, uy, fallbackHalf)));
      }
    }

    const stepWallStyle = surface(style, FACE_KIND.wall, GRANITE, STYLE_FLAG.blank);
    const stepPlinthStyle = surface(style, FACE_KIND.trim, PLINTH);
    const deckStyle = surface(style, FACE_KIND.roof, GRANITE, 0, ROOF_SHAPE_ID.flat);
    for (let i = 0; i < stepRings.length; i++) {
      const yBottom = i * STEP_HEIGHT;
      const yTop = (i + 1) * STEP_HEIGHT;
      emitRingWalls(sink, stepRings[i], yBottom, yTop, i === 0 ? stepPlinthStyle : stepWallStyle);
      emitDeck(sink, stepRings[i].points, yTop, deckStyle);
    }

    // --- tapering four-sided obelisk shaft ---------------------------------
    const topStep = stepRings[stepRings.length - 1];
    const availableHalf = distanceToRing(topStep.points, centre[0], centre[1]) - 0.12;
    const shaftBaseHalf = Math.max(MIN_SHAFT_HALF, Math.min(SHAFT_BASE_HALF, availableHalf));
    const shaftTopHalf = Math.max(
      MIN_SHAFT_HALF * 0.5,
      (shaftBaseHalf / SHAFT_BASE_HALF) * SHAFT_TOP_HALF,
    );
    const shaftStyle = surface(style, FACE_KIND.wall, GRANITE, STYLE_FLAG.blank);
    emitSquareSection(
      sink, centre, ux, uy, shaftBaseHalf, shaftTopHalf, SHAFT_BASE_Y, SHAFT_TOP_Y, shaftStyle,
    );

    // --- bronze relief bands around the shaft ------------------------------
    const bandStyle = surface(style, FACE_KIND.trim, BRONZE);
    const shaftSpan = SHAFT_TOP_Y - SHAFT_BASE_Y;
    const halfAt = (height: number): number =>
      shaftBaseHalf +
      (shaftTopHalf - shaftBaseHalf) * ((height - SHAFT_BASE_Y) / shaftSpan);
    for (const fraction of BAND_FRACTIONS) {
      const bandCentre = SHAFT_BASE_Y + shaftSpan * fraction;
      const half = halfAt(bandCentre) + BAND_OUTSET;
      emitSquareSection(
        sink,
        centre,
        ux,
        uy,
        half,
        half,
        bandCentre - BAND_HEIGHT / 2,
        bandCentre + BAND_HEIGHT / 2,
        bandStyle,
      );
    }

    // --- stone pyramidion + gold star finial -------------------------------
    emitSquarePyramid(
      sink,
      centre,
      ux,
      uy,
      shaftTopHalf,
      SHAFT_TOP_Y,
      PYRAMIDION_TOP_Y,
      surface(style, FACE_KIND.wall, GRANITE, STYLE_FLAG.blank),
    );
    emitStar(
      sink,
      centre,
      STAR_CENTER_Y,
      STAR_RADIUS,
      STAR_HALF_HEIGHT,
      surface(style, FACE_KIND.trim, GOLD),
    );

    // --- eternal flame on a low slab in front of the pedestal --------------
    // The flame is south of the monument (towards the avenue in the reference
    // shot), i.e. local -Y.
    const baseExtent = Math.max(
      distanceToRing(basePoints, centre[0], centre[1]),
      Math.min(rect.halfLength, 9),
    );
    const flameCentre: Point2 = [centre[0], centre[1] - (baseExtent + FLAME_GAP)];
    emitEternalFlame(sink, flameCentre, ux, uy, style);
  } catch (error) {
    warn(`victory obelisk failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
