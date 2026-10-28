/**
 * Minsk TV / radio tower (Телебашня, ул. Коммунистическая) — landmark geometry.
 *
 * OSM maps it as a 176 m `building=tower` with a bogus 168 m wall + pyramidal
 * cap, so the curated-landmark route rebuilds a real lattice mast procedurally
 * from the measured 1954–1956 profile (Wikipedia + reference photo + the user's
 * old X-Plane model `telebashnya.obj`, 261 verts / ~138 tris):
 *
 *   base square 20.5 m side, tapered square mast to 6.4 m at 150 m,
 *   horizontal ring braces every ~11 m + X-diagonals on all four faces,
 *   projecting square platforms at 118.3 / 127.1 / 134.8 / 142.9 m,
 *   octagonal 20 m platform at 160 m, banded top mast 160–174 m,
 *   antennas/lightning rods and a red aviation beacon at 176 m.
 *
 * Base orientation comes from the OSM `outline` min-area rectangle (the contour
 * is a rotated square); the bogus `volumes` are ignored entirely. No third-party
 * geometry or textures are imported — everything is MeshSink triangles.
 *
 * Deterministic, never throws; problems are reported through `onWarning`.
 */

import { FACE_KIND, ROOF_SHAPE_ID, STYLE_FLAG } from '../../shared/geometry';
import type { BuildingFeature, Polygon } from '../../shared/types';
import type { MeshSink, SurfaceStyle } from './meshSink';
import { cleanRing, minAreaRect, polygonCentroid, type Point2 } from './polygon2d';
import { srgbFromHex, type BuildingStyle } from './style';

// --- measured profile (metres) -------------------------------------------
export const TV_TOWER_TOTAL_HEIGHT = 176;
export const TV_TOWER_BASE_HALF = 10.25; // 20.5 m square base
export const TV_TOWER_MAST_HALF_AT_150 = 3.2; // 6.4 m at 150 m
export const TV_TOWER_LATTICE_TOP = 150;
export const TV_TOWER_BIG_PLATFORM = 160;
export const TV_TOWER_BIG_PLATFORM_RADIUS = 10;
export const TV_TOWER_PLATFORM_HEIGHTS = [118.3, 127.1, 134.8, 142.9] as const;
const RING_HEIGHTS = [11, 22, 33, 44, 55, 66, 77, 88, 99, 110, 121, 132, 143, 150] as const;
const LEG_HALF_WIDTH_BASE = 0.275; // 0.55 m square truss legs
const LEG_HALF_WIDTH_TOP = 0.16; // 0.32 m at 150 m
const RING_THICKNESS = 0.34;
const DIAGONAL_THICKNESS = 0.17;
const PLATFORM_PROJECTION = 3.5;
const PLATFORM_FASCIA = 0.35;
const RAIL_HEIGHT = 0.9;
const RAIL_THICKNESS = 0.09;
const POST_THICKNESS = 0.1;
const FOOTING_HEIGHT = 1.2;
const FOOTING_HALF = 1.1;
const MAST_TOP = 174;
const SPIKE_TOP = 175.5;

/** Palette (sRGB literals) so the landmark reads as red-brown steel. */
export const TV_TOWER_COLOURS = {
  steel: srgbFromHex('#8E2B22'),
  white: srgbFromHex('#E8E6DE'),
  deck: srgbFromHex('#8B8D8A'),
  concrete: srgbFromHex('#6E6F6B'),
  dish: srgbFromHex('#EDEBE4'),
  beacon: srgbFromHex('#C0392B'),
  redLight: srgbFromHex('#B03A2E'),
} as const;

type Vec3 = [number, number, number];

interface Frame {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  /** Half side of the base square derived from the outline min-area rect. */
  baseHalf: number;
}

/** True when the feature is the TV tower landmark. */
export function isTvTowerBuilding(building: BuildingFeature): boolean {
  return building?.landmark === 'tv-tower';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function towerSurface(
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

function addQuadFace(
  sink: MeshSink,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  normal: Vec3,
  surface: SurfaceStyle,
): void {
  const u1 = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const u2 = u1 + Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
  const u3 = u2 + Math.hypot(d[0] - c[0], d[1] - c[1], d[2] - c[2]);
  sink.addQuad(
    a[0], a[1], a[2],
    b[0], b[1], b[2],
    c[0], c[1], c[2],
    d[0], d[1], d[2],
    0, a[1], u1, b[1], u2, c[1], u3, d[1],
    normal[0], normal[1], normal[2], surface,
  );
}

function normalize3(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Generic thin truss/box member between two world points (8 triangles). */
function addBeam(
  sink: MeshSink,
  p0: Vec3,
  p1: Vec3,
  normal: Vec3,
  thickness: number,
  surface: SurfaceStyle,
): void {
  const dir = normalize3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
  let n = normalize3(normal);
  const along = Math.abs(dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2]);
  if (along > 0.98) {
    // Degenerate reference: fall back to a horizontal axis.
    n = Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : normalize3(cross3([0, 1, 0], dir));
  }
  let e = normalize3(cross3(n, dir));
  if (e[0] === 0 && e[1] === 0 && e[2] === 0) e = [0, 1, 0];
  const h = thickness / 2;
  const corner = (p: Vec3, se: number, sn: number): Vec3 => [
    p[0] + e[0] * h * se + n[0] * h * sn,
    p[1] + e[1] * h * se + n[1] * h * sn,
    p[2] + e[2] * h * se + n[2] * h * sn,
  ];
  const p0ee = corner(p0, 1, 1);
  const p0em = corner(p0, 1, -1);
  const p0me = corner(p0, -1, 1);
  const p0mm = corner(p0, -1, -1);
  const p1ee = corner(p1, 1, 1);
  const p1em = corner(p1, 1, -1);
  const p1me = corner(p1, -1, 1);
  const p1mm = corner(p1, -1, -1);
  addQuadFace(sink, p0ee, p0em, p1em, p1ee, n, surface);
  addQuadFace(sink, p0mm, p0me, p1me, p1mm, [-n[0], -n[1], -n[2]], surface);
  addQuadFace(sink, p0me, p0ee, p1ee, p1me, e, surface);
  addQuadFace(sink, p0em, p0mm, p1mm, p1em, [-e[0], -e[1], -e[2]], surface);
}

/** Axis-aligned box in the tower frame (footings, cabin, beacon, lights). */
function addBox(
  sink: MeshSink,
  frame: Frame,
  u: number,
  v: number,
  y0: number,
  y1: number,
  halfU: number,
  halfV: number,
  surface: SurfaceStyle,
  skipBottom = true,
): void {
  const p = (du: number, dv: number, y: number): Vec3 =>
    toWorld(frame, u + du * halfU, v + dv * halfV, y);
  const uDir = toWorld(frame, u + 1, v, 0); // world direction helper (y ignored)
  const vDir = toWorld(frame, u, v + 1, 0);
  const nU: Vec3 = normalize3([uDir[0] - toWorld(frame, u, v, 0)[0], 0, uDir[2] - toWorld(frame, u, v, 0)[2]]);
  const nV: Vec3 = normalize3([vDir[0] - toWorld(frame, u, v, 0)[0], 0, vDir[2] - toWorld(frame, u, v, 0)[2]]);
  addQuadFace(sink, p(1, -1, y0), p(1, 1, y0), p(1, 1, y1), p(1, -1, y1), nU, surface);
  addQuadFace(sink, p(-1, 1, y0), p(-1, -1, y0), p(-1, -1, y1), p(-1, 1, y1), [-nU[0], 0, -nU[2]], surface);
  addQuadFace(sink, p(1, 1, y0), p(-1, 1, y0), p(-1, 1, y1), p(1, 1, y1), nV, surface);
  addQuadFace(sink, p(-1, -1, y0), p(1, -1, y0), p(1, -1, y1), p(-1, -1, y1), [-nV[0], 0, -nV[2]], surface);
  addQuadFace(sink, p(-1, -1, y1), p(1, -1, y1), p(1, 1, y1), p(-1, 1, y1), [0, 1, 0], surface);
  if (!skipBottom) {
    addQuadFace(sink, p(-1, 1, y0), p(1, 1, y0), p(1, -1, y0), p(-1, -1, y0), [0, -1, 0], surface);
  }
}

/** Local frame (u along the outline min-area rectangle long axis) -> world. */
function toWorld(frame: Frame, u: number, v: number, y: number): Vec3 {
  const x = frame.cx + frame.ux * u + frame.vx * v;
  const localY = frame.cy + frame.uy * u + frame.vy * v;
  return [x, y, -localY];
}

function frameAxisU(frame: Frame): Vec3 {
  return normalize3([frame.ux, 0, -frame.uy]);
}

function frameAxisV(frame: Frame): Vec3 {
  return normalize3([frame.vx, 0, -frame.vy]);
}

/** Mast half-width at a height (linear taper 20.5 m -> 6.4 m at 150 m). */
function mastHalfAt(baseHalf: number, y: number): number {
  if (y >= TV_TOWER_LATTICE_TOP) return TV_TOWER_MAST_HALF_AT_150;
  const t = Math.max(0, y) / TV_TOWER_LATTICE_TOP;
  return baseHalf + (TV_TOWER_MAST_HALF_AT_150 - baseHalf) * t;
}

/** Append the whole TV tower (base pad + lattice mast + antenna + beacon). */
export function addTvTower(
  sink: MeshSink,
  building: BuildingFeature,
  style: BuildingStyle,
  onWarning?: (message: string) => void,
): void {
  const warn = onWarning ?? (() => {});
  try {
    if (!building) {
      warn('tv tower: missing building feature');
      return;
    }
    const height = building.height;
    if (!Number.isFinite(height) || height < 50) {
      warn(`tv tower: malformed height ${String(height)}; geometry skipped`);
      return;
    }
    const frame = resolveFrame(building);
    if (frame) {
      buildTower(sink, style, frame);
    } else {
      warn('tv tower: missing or unusable outline; building a simplified tapered mast');
      const fallback: Frame = {
        cx: 0,
        cy: 0,
        ux: 1,
        uy: 0,
        vx: 0,
        vy: 1,
        baseHalf: TV_TOWER_BASE_HALF,
      };
      buildSimplifiedMast(sink, style, fallback);
    }
  } catch (error) {
    warn(`tv tower failed: ${describeError(error)}`);
  }
}

/** Derive centre + base orientation from the OSM outline min-area rectangle. */
function resolveFrame(building: BuildingFeature): Frame | null {
  const outline: Polygon | undefined = building.outline;
  if (!outline || !outline.length) return null;
  const ring: Point2[] = cleanRing(outline[0]);
  if (ring.length < 3) return null;
  const rect = minAreaRect(ring);
  const centre = polygonCentroid([ring]);
  if (!rect || !Number.isFinite(centre[0]) || !Number.isFinite(centre[1])) return null;
  const baseHalf = Math.min(rect.halfLength, rect.halfWidth);
  if (!(baseHalf > 3) || !Number.isFinite(baseHalf)) return null;
  return {
    cx: centre[0],
    cy: centre[1],
    ux: rect.ux,
    uy: rect.uy,
    vx: -rect.uy,
    vy: rect.ux,
    baseHalf,
  };
}

/** Full lattice tower. */
function buildTower(sink: MeshSink, style: BuildingStyle, frame: Frame): void {
  const clampHalf = Math.min(11.5, Math.max(8, frame.baseHalf));
  const concrete = towerSurface(style, FACE_KIND.wall, TV_TOWER_COLOURS.concrete, STYLE_FLAG.blank);
  const steel = towerSurface(style, FACE_KIND.wall, TV_TOWER_COLOURS.steel, STYLE_FLAG.blank);
  const white = towerSurface(style, FACE_KIND.trim, TV_TOWER_COLOURS.white, STYLE_FLAG.blank);
  const deckGrey = towerSurface(style, FACE_KIND.roof, TV_TOWER_COLOURS.deck, STYLE_FLAG.blank, ROOF_SHAPE_ID.flat);
  const trimGrey = towerSurface(style, FACE_KIND.trim, TV_TOWER_COLOURS.deck, STYLE_FLAG.blank);
  const dishSurface = towerSurface(style, FACE_KIND.trim, TV_TOWER_COLOURS.dish, STYLE_FLAG.blank);
  const beaconSurface = towerSurface(style, FACE_KIND.glass, TV_TOWER_COLOURS.beacon, STYLE_FLAG.blank);
  const redLightSurface = towerSurface(style, FACE_KIND.glass, TV_TOWER_COLOURS.redLight, STYLE_FLAG.blank);

  const axisU = frameAxisU(frame);
  const axisV = frameAxisV(frame);
  const legs: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  // --- footings + four tapered truss legs --------------------------------
  for (const [su, sv] of legs) {
    const u = su * clampHalf;
    const v = sv * clampHalf;
    addBox(sink, frame, u, v, 0, FOOTING_HEIGHT, FOOTING_HALF, FOOTING_HALF, concrete, false);
    addTaperedLeg(sink, frame, u, v, clampHalf, LEG_HALF_WIDTH_BASE, LEG_HALF_WIDTH_TOP, steel);
  }

  // --- lattice rings + X-diagonals ---------------------------------------
  for (const y of RING_HEIGHTS) {
    const half = mastHalfAt(clampHalf, y);
    addSquareRing(sink, frame, half, y, RING_THICKNESS, steel);
  }
  const levels: number[] = [0, ...RING_HEIGHTS];
  for (let i = 0; i + 1 < levels.length; i++) {
    const y0 = levels[i];
    const y1 = levels[i + 1];
    const h0 = mastHalfAt(clampHalf, y0);
    const h1 = mastHalfAt(clampHalf, y1);
    const singleDiagonal = y0 >= 77;
    for (let face = 0; face < 4; face++) {
      const [su, sv, normal] = faceBasis(face, axisU, axisV);
      // Two legs of this face: offsets along the in-face tangent.
      const p0a = facePoint(frame, su, sv, -1, h0, y0);
      const p0b = facePoint(frame, su, sv, 1, h0, y0);
      const p1a = facePoint(frame, su, sv, -1, h1, y1);
      const p1b = facePoint(frame, su, sv, 1, h1, y1);
      addBeam(sink, p0a, p1b, normal, DIAGONAL_THICKNESS, steel);
      if (!singleDiagonal) addBeam(sink, p0b, p1a, normal, DIAGONAL_THICKNESS, steel);
    }
  }

  // --- projecting square platforms ---------------------------------------
  for (const y of TV_TOWER_PLATFORM_HEIGHTS) {
    const half = mastHalfAt(clampHalf, y) + PLATFORM_PROJECTION;
    addSquarePlatform(sink, frame, half, y, deckGrey, trimGrey, white);
    addDishesForLevel(sink, frame, half, y, axisU, axisV, dishSurface);
  }

  // --- big octagonal platform at 160 m -----------------------------------
  addBigPlatform(sink, frame, axisU, axisV, deckGrey, trimGrey, white, concrete);

  // --- banded top mast + antennas + beacon -------------------------------
  addTopMast(sink, frame, steel, white, beaconSurface);

  // --- antenna arrays at 149.8 / 163.7 m ---------------------------------
  addAntennaArray(sink, frame, clampHalf, 149.8, 3.4, white);
  addAntennaArray(sink, frame, 0, 163.7, 2.6, white, true);

  // --- aviation warning lights ------------------------------------------
  for (const y of [50, 100, 160]) {
    addBox(sink, frame, clampHalf * 0.6, 0, y, y + 0.4, 0.22, 0.22, redLightSurface);
  }
}

/** Four-sided tapered leg from the footings to the 150 m platform. */
function addTaperedLeg(
  sink: MeshSink,
  frame: Frame,
  u: number,
  v: number,
  baseHalf: number,
  halfWidthBase: number,
  halfWidthTop: number,
  surface: SurfaceStyle,
): void {
  const topHalf = mastHalfAt(baseHalf, TV_TOWER_LATTICE_TOP);
  const scaleTop = topHalf / baseHalf;
  const uTop = u * scaleTop;
  const vTop = v * scaleTop;
  const y0 = 0;
  const y1 = TV_TOWER_LATTICE_TOP;
  const w0 = halfWidthBase;
  const w1 = halfWidthTop;
  const p = (uu: number, vv: number, du: number, dv: number, w: number, y: number): Vec3 =>
    toWorld(frame, uu + du * w, vv + dv * w, y);
  const b = {
    ee: p(u, v, 1, 1, w0, y0),
    em: p(u, v, 1, -1, w0, y0),
    me: p(u, v, -1, 1, w0, y0),
    mm: p(u, v, -1, -1, w0, y0),
  };
  const t = {
    ee: p(uTop, vTop, 1, 1, w1, y1),
    em: p(uTop, vTop, 1, -1, w1, y1),
    me: p(uTop, vTop, -1, 1, w1, y1),
    mm: p(uTop, vTop, -1, -1, w1, y1),
  };
  const axisU = frameAxisU(frame);
  const axisV = frameAxisV(frame);
  addQuadFace(sink, b.ee, b.em, t.em, t.ee, axisU, surface);
  addQuadFace(sink, b.mm, b.me, t.me, t.mm, [-axisU[0], 0, -axisU[2]], surface);
  addQuadFace(sink, b.me, b.ee, t.ee, t.me, axisV, surface);
  addQuadFace(sink, b.em, b.mm, t.mm, t.em, [-axisV[0], 0, -axisV[2]], surface);
}

/** Face basis: outward horizontal normal + two tangent signs. */
function faceBasis(face: number, axisU: Vec3, axisV: Vec3): [number, number, Vec3] {
  // su/sv control whether the face sits on +u/-u or +v/-v side.
  switch (face) {
    case 0:
      return [0, 1, axisV]; // +v face
    case 1:
      return [0, -1, [-axisV[0], 0, -axisV[2]]]; // -v face
    case 2:
      return [1, 0, axisU]; // +u face
    default:
      return [-1, 0, [-axisU[0], 0, -axisU[2]]]; // -u face
  }
}

/** A point on one face: `side` picks the in-face tangent direction (±1). */
function facePoint(
  frame: Frame,
  su: number,
  sv: number,
  side: number,
  half: number,
  y: number,
): Vec3 {
  if (sv !== 0) return toWorld(frame, side * half, sv * half, y);
  return toWorld(frame, su * half, side * half, y);
}

/** Four horizontal ring braces forming a square ring at height y. */
function addSquareRing(
  sink: MeshSink,
  frame: Frame,
  half: number,
  y: number,
  thickness: number,
  surface: SurfaceStyle,
): void {
  const axisU = frameAxisU(frame);
  const axisV = frameAxisV(frame);
  const corners = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ] as const;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const normal: Vec3 =
      i === 0
        ? [-axisV[0], 0, -axisV[2]]
        : i === 1
          ? axisU
          : i === 2
            ? axisV
            : [-axisU[0], 0, -axisU[2]];
    addBeam(sink, toWorld(frame, a[0], a[1], y), toWorld(frame, b[0], b[1], y), normal, thickness, surface);
  }
}

/** Square grey deck + fascia + railing posts/rail at one height. */
function addSquarePlatform(
  sink: MeshSink,
  frame: Frame,
  half: number,
  y: number,
  deckSurface: SurfaceStyle,
  trimSurface: SurfaceStyle,
  whiteSurface: SurfaceStyle,
): void {
  const axisU = frameAxisU(frame);
  const axisV = frameAxisV(frame);
  const corners = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ] as const;
  // Deck top.
  addQuadFace(
    sink,
    toWorld(frame, -half, -half, y),
    toWorld(frame, half, -half, y),
    toWorld(frame, half, half, y),
    toWorld(frame, -half, half, y),
    [0, 1, 0],
    deckSurface,
  );
  // Fascia ring.
  for (const [a, b] of [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ] as const) {
    const normal = normalize3(
      cross3(
        [0, 1, 0],
        normalize3([
          toWorld(frame, b[0], b[1], 0)[0] - toWorld(frame, a[0], a[1], 0)[0],
          0,
          toWorld(frame, b[0], b[1], 0)[2] - toWorld(frame, a[0], a[1], 0)[2],
        ]),
      ),
    );
    addQuadFace(
      sink,
      toWorld(frame, a[0], a[1], y - PLATFORM_FASCIA),
      toWorld(frame, b[0], b[1], y - PLATFORM_FASCIA),
      toWorld(frame, b[0], b[1], y),
      toWorld(frame, a[0], a[1], y),
      normal,
      trimSurface,
    );
  }
  // Railing: 8 posts + 4 top rails.
  for (let side = 0; side < 4; side++) {
    const a = corners[side];
    const b = corners[(side + 1) % 4];
    const normal = normalize3(
      cross3(
        [0, 1, 0],
        normalize3([
          toWorld(frame, b[0], b[1], 0)[0] - toWorld(frame, a[0], a[1], 0)[0],
          0,
          toWorld(frame, b[0], b[1], 0)[2] - toWorld(frame, a[0], a[1], 0)[2],
        ]),
      ),
    );
    for (const t of [0, 0.5, 1]) {
      const u = a[0] + (b[0] - a[0]) * t;
      const v = a[1] + (b[1] - a[1]) * t;
      addBeam(
        sink,
        toWorld(frame, u, v, y),
        toWorld(frame, u, v, y + RAIL_HEIGHT),
        normal,
        POST_THICKNESS,
        whiteSurface,
      );
    }
    addBeam(
      sink,
      toWorld(frame, a[0], a[1], y + RAIL_HEIGHT),
      toWorld(frame, b[0], b[1], y + RAIL_HEIGHT),
      normal,
      RAIL_THICKNESS,
      whiteSurface,
    );
  }
}

/** Big octagonal railed platform at 160 m + equipment cabin + antenna mast. */
function addBigPlatform(
  sink: MeshSink,
  frame: Frame,
  axisU: Vec3,
  axisV: Vec3,
  deckSurface: SurfaceStyle,
  trimSurface: SurfaceStyle,
  whiteSurface: SurfaceStyle,
  concreteSurface: SurfaceStyle,
): void {
  const y = TV_TOWER_BIG_PLATFORM;
  const radius = TV_TOWER_BIG_PLATFORM_RADIUS;
  const points: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    points.push(toWorld(frame, Math.cos(angle) * radius, Math.sin(angle) * radius, y));
  }
  const centre = toWorld(frame, 0, 0, y);
  // Octagonal deck fan (facing up).
  for (let i = 0; i < 8; i++) {
    const a = points[i];
    const b = points[(i + 1) % 8];
    sink.addTriangle(
      centre[0], centre[1], centre[2],
      a[0], a[1], a[2],
      b[0], b[1], b[2],
      0, 1, 0,
      0, y,
      Math.hypot(a[0] - centre[0], a[2] - centre[2]), y,
      Math.hypot(a[0] - centre[0], a[2] - centre[2]) + Math.hypot(b[0] - a[0], b[2] - a[2]), y,
      deckSurface,
    );
  }
  // Fascia ring.
  for (let i = 0; i < 8; i++) {
    const a = points[i];
    const b = points[(i + 1) % 8];
    const out = normalize3([(a[0] + b[0]) / 2 - centre[0], 0, (a[2] + b[2]) / 2 - centre[2]]);
    addQuadFace(
      sink,
      [a[0], y - 0.5, a[2]],
      [b[0], y - 0.5, b[2]],
      b,
      a,
      out,
      trimSurface,
    );
  }
  // Railing: 16 posts + 16 top rail spans.
  const railPoints: Vec3[] = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    railPoints.push(toWorld(frame, Math.cos(angle) * radius, Math.sin(angle) * radius, y + RAIL_HEIGHT));
  }
  for (let i = 0; i < 16; i++) {
    const a = railPoints[i];
    const b = railPoints[(i + 1) % 16];
    const out = normalize3([a[0] - centre[0], 0, a[2] - centre[2]]);
    addBeam(sink, [a[0], y, a[2]], a, out, POST_THICKNESS, whiteSurface);
    const outMid = normalize3([(a[0] + b[0]) / 2 - centre[0], 0, (a[2] + b[2]) / 2 - centre[2]]);
    addBeam(sink, a, b, outMid, RAIL_THICKNESS, whiteSurface);
  }
  // Equipment cabin on the deck.
  addBox(sink, frame, 4.2, 0.8, y, y + 2.6, 1.6, 1.2, concreteSurface);
  // Four lightning rods at platform corners.
  for (const index of [0, 2, 4, 6]) {
    const angle = (index / 8) * Math.PI * 2;
    const p = toWorld(frame, Math.cos(angle) * (radius - 0.7), Math.sin(angle) * (radius - 0.7), y);
    addBeam(sink, p, [p[0], y + 4, p[2]], axisU, 0.1, whiteSurface);
  }
}

/** Banded red/white top mast 160–174 m, spike, beacon. */
function addTopMast(
  sink: MeshSink,
  frame: Frame,
  steelSurface: SurfaceStyle,
  whiteSurface: SurfaceStyle,
  beaconSurface: SurfaceStyle,
): void {
  const y0 = TV_TOWER_BIG_PLATFORM;
  const sections = 4;
  const step = (MAST_TOP - y0) / sections;
  const halfBase = 1.5;
  const halfTop = 0.9;
  const axisU = frameAxisU(frame);
  const axisV = frameAxisV(frame);
  for (let i = 0; i < sections; i++) {
    const a = y0 + step * i;
    const b = a + step;
    const ha = halfBase + ((halfTop - halfBase) * (a - y0)) / (MAST_TOP - y0);
    const hb = halfBase + ((halfTop - halfBase) * (b - y0)) / (MAST_TOP - y0);
    const surface = i % 2 === 0 ? steelSurface : whiteSurface;
    const p = (u: number, v: number, y: number): Vec3 => toWorld(frame, u, v, y);
    addQuadFace(sink, p(-ha, -ha, a), p(ha, -ha, a), p(hb, -hb, b), p(-hb, -hb, b), [-axisV[0], 0, -axisV[2]], surface);
    addQuadFace(sink, p(ha, -ha, a), p(ha, ha, a), p(hb, hb, b), p(hb, -hb, b), axisU, surface);
    addQuadFace(sink, p(ha, ha, a), p(-ha, ha, a), p(-hb, hb, b), p(hb, hb, b), axisV, surface);
    addQuadFace(sink, p(-ha, ha, a), p(-ha, -ha, a), p(-hb, -hb, b), p(-hb, hb, b), [-axisU[0], 0, -axisU[2]], surface);
  }
  // Thin antenna spike and aviation beacon at 176 m.
  const spikeBase = toWorld(frame, 0, 0, MAST_TOP);
  addBeam(sink, spikeBase, [spikeBase[0], SPIKE_TOP, spikeBase[2]], axisU, 0.12, whiteSurface);
  const beacon = toWorld(frame, 0, 0, SPIKE_TOP);
  addBeam(sink, [beacon[0], SPIKE_TOP, beacon[2]], [beacon[0], TV_TOWER_TOTAL_HEIGHT, beacon[2]], axisU, 0.5, beaconSurface);
  addQuadFace(
    sink,
    [beacon[0] - 0.3, TV_TOWER_TOTAL_HEIGHT, beacon[2] - 0.3],
    [beacon[0] + 0.3, TV_TOWER_TOTAL_HEIGHT, beacon[2] - 0.3],
    [beacon[0] + 0.3, TV_TOWER_TOTAL_HEIGHT, beacon[2] + 0.3],
    [beacon[0] - 0.3, TV_TOWER_TOTAL_HEIGHT, beacon[2] + 0.3],
    [0, 1, 0],
    beaconSurface,
  );
}

/** Short antenna/array elements sticking out of the mast at one height. */
function addAntennaArray(
  sink: MeshSink,
  frame: Frame,
  baseHalf: number,
  y: number,
  length: number,
  surface: SurfaceStyle,
  fromTopMast = false,
): void {
  const axisU = frameAxisU(frame);
  const axisV = frameAxisV(frame);
  const half = fromTopMast ? 1.2 : mastHalfAt(baseHalf, y);
  const dirs: Vec3[] = [axisU, [-axisU[0], 0, -axisU[2]], axisV, [-axisV[0], 0, -axisV[2]]];
  for (const dir of dirs) {
    const start = toWorld(frame, 0, 0, y);
    // Move to the mast wall along dir, then protrude.
    const p0: Vec3 = [start[0] + dir[0] * half, y, start[2] + dir[2] * half];
    const p1: Vec3 = [p0[0] + dir[0] * length, y, p0[2] + dir[2] * length];
    addBeam(sink, p0, p1, [0, 1, 0], 0.22, surface);
    // Small vertical panel at the tip.
    addBeam(sink, p1, [p1[0], y - 0.9, p1[2]], [dir[0], 0, dir[2]], 0.18, surface);
  }
}

/** White parabolic dishes attached to the platform edges (deterministic). */
function addDishesForLevel(
  sink: MeshSink,
  frame: Frame,
  half: number,
  y: number,
  axisU: Vec3,
  axisV: Vec3,
  surface: SurfaceStyle,
): void {
  const radius = 1.35;
  const positions: { u: number; v: number; normal: Vec3 }[] = [
    { u: half, v: -half * 0.35, normal: axisU },
    { u: -half, v: half * 0.35, normal: [-axisU[0], 0, -axisU[2]] },
  ];
  for (const position of positions) {
    const base = toWorld(frame, position.u, position.v, y + 1.2);
    const n = position.normal;
    const centre: Vec3 = [base[0] + n[0] * 0.6, base[1], base[2] + n[2] * 0.6];
    addDish(sink, centre, n, radius, surface);
  }
}

/** Octagonal dish disc facing along `normal`. */
function addDish(
  sink: MeshSink,
  centre: Vec3,
  normal: Vec3,
  radius: number,
  surface: SurfaceStyle,
): void {
  const n = normalize3(normal);
  const tangent = normalize3(cross3([0, 1, 0], n));
  const up: Vec3 = [0, 1, 0];
  const segments = 8;
  const back: Vec3[] = [];
  const front: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const px = centre[0] + tangent[0] * cos * radius + up[0] * sin * radius;
    const py = centre[1] + tangent[1] * cos * radius + up[1] * sin * radius;
    const pz = centre[2] + tangent[2] * cos * radius + up[2] * sin * radius;
    back.push([px, py, pz]);
    front.push([px + n[0] * 0.18, py + n[1] * 0.18, pz + n[2] * 0.18]);
  }
  // Backing plate facing the tower (cheap).
  for (let i = 1; i + 1 < segments; i++) {
    sink.addTriangle(
      centre[0], centre[1], centre[2],
      back[i + 1][0], back[i + 1][1], back[i + 1][2],
      back[i][0], back[i][1], back[i][2],
      -n[0], -n[1], -n[2],
      0, 0, i + 1, 0, i, 0,
      surface,
    );
  }
  // Front cone/disc + rim.
  for (let i = 0; i < segments; i++) {
    const a = back[i];
    const b = back[(i + 1) % segments];
    const fa = front[i];
    const fb = front[(i + 1) % segments];
    const radial = normalize3(
      cross3(
        [0, 1, 0],
        normalize3([b[0] - a[0], 0, b[2] - a[2]]),
      ),
    );
    addQuadFace(sink, a, b, fb, fa, radial, surface);
  }
  const frontCentre: Vec3 = [centre[0] + n[0] * 0.18, centre[1] + n[1] * 0.18, centre[2] + n[2] * 0.18];
  for (let i = 0; i < segments; i++) {
    const a = front[i];
    const b = front[(i + 1) % segments];
    sink.addTriangle(
      frontCentre[0], frontCentre[1], frontCentre[2],
      a[0], a[1], a[2],
      b[0], b[1], b[2],
      n[0], n[1], n[2],
      0, 0, i, 1, i + 1, 1,
      surface,
    );
  }
}

/** Minimal fallback: tapered mast with a few rings, mast, beacon. */
function buildSimplifiedMast(sink: MeshSink, style: BuildingStyle, frame: Frame): void {
  const steel = towerSurface(style, FACE_KIND.wall, TV_TOWER_COLOURS.steel, STYLE_FLAG.blank);
  const white = towerSurface(style, FACE_KIND.trim, TV_TOWER_COLOURS.white, STYLE_FLAG.blank);
  const beaconSurface = towerSurface(style, FACE_KIND.glass, TV_TOWER_COLOURS.beacon, STYLE_FLAG.blank);
  const baseHalf = TV_TOWER_BASE_HALF;
  const axisU = frameAxisU(frame);
  const axisV = frameAxisV(frame);
  for (const [su, sv] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    addTaperedLeg(sink, frame, su * baseHalf, sv * baseHalf, baseHalf, LEG_HALF_WIDTH_BASE, LEG_HALF_WIDTH_TOP, steel);
  }
  for (const y of [11, 33, 55, 77, 99, 121, 143, 150]) {
    addSquareRing(sink, frame, mastHalfAt(baseHalf, y), y, RING_THICKNESS, steel);
  }
  const faces: [number, Vec3][] = [
    [0, axisV],
    [1, [-axisV[0], 0, -axisV[2]]],
    [2, axisU],
    [3, [-axisU[0], 0, -axisU[2]]],
  ];
  for (const [face, base] of faces) {
    for (const y of [0, 33, 66, 99, 132]) {
      const halfA = mastHalfAt(baseHalf, y);
      const halfB = mastHalfAt(baseHalf, y + 33);
      const su = face === 2 ? 1 : face === 3 ? -1 : 0;
      const sv = face === 0 ? 1 : face === 1 ? -1 : 0;
      const p0 = facePoint(frame, su, sv, -1, halfA, y);
      const p1 = facePoint(frame, su, sv, 1, halfB, y + 33);
      addBeam(sink, p0, p1, base, DIAGONAL_THICKNESS, steel);
    }
  }
  addTopMast(sink, frame, steel, white, beaconSurface);
}
