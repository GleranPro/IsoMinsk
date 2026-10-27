/**
 * Stadium / grandstand special-case geometry (Milestone B follow-up).
 *
 * An OSM `building=stadium` is an arena, not a solid slab: the pipeline gives
 * the outer arena footprint (often an oval with dozens of vertices) plus inner
 * detail volumes. Rendering the outer footprint as a 16 m extrusion produces a
 * cylinder/"oval slab". Instead we generate a simple bowl:
 *
 *   outer wall (ring, base -> outerHeight)
 *     -> sloped seating ring strip (outer ring @ outerHeight -> inner ring @ 2.5 m)
 *       -> inner rim wall (inner ring, base -> 2.5 m)
 *         -> flat green field disc inside the inner ring @ +0.35 m
 *
 * The inner ring is a radial scale of the outer ring about the polygon
 * centroid (clean elliptical result for oval footprints). Second/lower volumes
 * of a stadium are ignored so the arena is never double-meshed.
 *
 * Grandstands (`building=grandstand`) are treated as a low, blank-walled stand
 * with a sloped (skillion) top instead of a box slab.
 */

import { FACE_KIND, STYLE_FLAG } from '../../shared/geometry';
import type { BuildingFeature, BuildingVolume } from '../../shared/types';
import { ENV_PALETTE } from '../../engine/materials/palette';
import { MeshSink, type SurfaceStyle } from './meshSink';
import {
  cleanRing,
  minAreaRect,
  pointInPolygon,
  polygonCentroid,
  signedArea,
  triangleSignedArea,
  type Point2,
} from './polygon2d';
import { srgbFromHex, type BuildingStyle } from './style';
import { boundaryNormalLocal, type RingInfo } from './walls';
import { triangulatePolygon } from './triangulate';

/** Seating ring horizontal depth as a fraction of the arena's short side. */
export const STADIUM_STAND_DEPTH_RATIO = 0.24;
/** Height of the inner pitch rim above the arena base (metres). */
export const STADIUM_INNER_RIM_HEIGHT = 2.5;
/** Height of the pitch surface above the arena base (metres). */
export const STADIUM_FIELD_HEIGHT = 0.35;
/** Hard cap on stadium wall height (metres). */
export const STADIUM_MAX_HEIGHT = 18;

export interface StadiumPlan {
  /** Outer arena ring (local metres). */
  outer: Point2[];
  /** Inner ring (radial scale of `outer` about the centroid). */
  inner: Point2[];
  /** Arena base elevation (metres). */
  base: number;
  /** Top of the outer wall / stand back (metres). */
  outerHeight: number;
  /** Top of the inner rim / stand front (metres). */
  innerHeight: number;
  /** Pitch surface elevation (metres). */
  fieldHeight: number;
}

/** True when the feature should be rendered as a stadium bowl. */
export function isStadiumBuilding(building: BuildingFeature): boolean {
  return building.archetype === 'stadium' || building.tags?.building === 'stadium';
}

/** True when the feature should be rendered as a low blank grandstand. */
export function isGrandstandBuilding(building: BuildingFeature): boolean {
  return building.tags?.building === 'grandstand';
}

function ringInfo(points: Point2[]): RingInfo {
  const area = signedArea(points);
  return { points, isHole: false, area, ccw: area > 0 };
}

function surfaceWithFlags(
  style: BuildingStyle,
  kind: number,
  color: SurfaceStyle['color'],
  extraFlags: number,
): SurfaceStyle {
  return {
    owner: style.owner,
    color,
    style: style.style,
    face: [kind, style.flags | extraFlags, style.trimIntensity, style.detailScale],
  };
}

/**
 * Build the bowl plan from the LARGEST exterior ring across all volumes.
 * Returns null when the data does not describe a usable arena.
 */
export function planStadiumBowl(building: BuildingFeature): StadiumPlan | null {
  const volumes = Array.isArray(building.volumes) ? building.volumes : [];
  let bestPoints: Point2[] | null = null;
  let bestArea = 0;
  let bestBase = 0;
  for (const volume of volumes) {
    const points = cleanRing(volume.footprint?.[0]);
    if (points.length < 3) continue;
    const area = Math.abs(signedArea(points));
    if (area > bestArea) {
      bestArea = area;
      bestPoints = points;
      bestBase = Number.isFinite(volume.minHeight) ? volume.minHeight : 0;
    }
  }
  if (!bestPoints || bestPoints.length < 3 || !(bestArea > 20)) return null;

  const rect = minAreaRect(bestPoints);
  if (!rect) return null;
  const shortSide = rect.halfWidth * 2;
  if (!(shortSide > 2)) return null;

  // horizontal seating depth ~24 % of the short side -> radial scale.
  const standDepth = STADIUM_STAND_DEPTH_RATIO * shortSide;
  const scale = 1 - (2 * standDepth) / shortSide; // = 0.52 for the default ratio
  if (!(scale > 0.3 && scale < 0.9)) return null;

  const centre = polygonCentroid([bestPoints]);
  const inner: Point2[] = bestPoints.map((p) => [
    centre[0] + (p[0] - centre[0]) * scale,
    centre[1] + (p[1] - centre[1]) * scale,
  ]);

  // The scaled ring must sit inside the outer ring (true for convex/star shaped
  // footprints, which is what arena outlines are; otherwise fall back to slabs).
  for (const point of inner) {
    if (!pointInPolygon([bestPoints], point[0], point[1])) return null;
  }

  const declaredHeight = Number.isFinite(building.height) ? building.height : 0;
  let outerHeight = Math.min(declaredHeight, STADIUM_MAX_HEIGHT);
  if (!(outerHeight > bestBase + 4)) outerHeight = bestBase + 10;
  const innerHeight = bestBase + STADIUM_INNER_RIM_HEIGHT;
  if (!(innerHeight < outerHeight - 1)) return null;

  return {
    outer: bestPoints,
    inner,
    base: bestBase,
    outerHeight,
    innerHeight,
    fieldHeight: bestBase + STADIUM_FIELD_HEIGHT,
  };
}

/** Append the whole bowl (walls, stands, rim, pitch) to the tile mesh. */
export function addStadiumBowl(sink: MeshSink, plan: StadiumPlan, style: BuildingStyle): void {
  const { outer, inner, base, outerHeight, innerHeight, fieldHeight } = plan;
  const n = Math.min(outer.length, inner.length);
  if (n < 3) return;

  const outerRing = ringInfo(outer);
  const innerRing = ringInfo(inner);
  const outerWall = surfaceWithFlags(style, FACE_KIND.wall, style.baseColor, STYLE_FLAG.blank);
  const standSurface = surfaceWithFlags(style, FACE_KIND.trim, style.trimColor, STYLE_FLAG.blank);
  const innerWall = surfaceWithFlags(style, FACE_KIND.wall, style.baseColor, STYLE_FLAG.blank);
  const pitchSurface = surfaceWithFlags(
    style,
    FACE_KIND.roof,
    srgbFromHex(ENV_PALETTE.pitch),
    STYLE_FLAG.blank,
  );

  let uOuter = 0;
  for (let i = 0; i < n; i++) {
    const p0 = outer[i];
    const p1 = outer[(i + 1) % n];
    const q0 = inner[i];
    const q1 = inner[(i + 1) % n];
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const u0 = uOuter;
    const u1 = uOuter + len;
    uOuter = u1;
    if (len < 1e-3) continue;

    const [nlx, nly] = boundaryNormalLocal(outerRing, i);
    const nx = nlx;
    const nz = -nly;
    // Outer wall: ground -> outerHeight.
    sink.addQuad(
      p0[0], base, -p0[1],
      p1[0], base, -p1[1],
      p1[0], outerHeight, -p1[1],
      p0[0], outerHeight, -p0[1],
      u0, 0, u1, 0, u1, outerHeight - base, u0, outerHeight - base,
      nx, 0, nz, outerWall,
    );

    // Seating strip: outer top edge -> inner ring at innerHeight. Desired normal
    // faces up and towards the pitch.
    const ax = p0[0];
    const ay = outerHeight;
    const az = -p0[1];
    const bx = p1[0];
    const by = outerHeight;
    const bz = -p1[1];
    const cx = q1[0];
    const cy = innerHeight;
    const cz = -q1[1];
    const dx = q0[0];
    const dy = innerHeight;
    const dz = -q0[1];
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    let snx = aby * acz - abz * acy;
    let sny = abz * acx - abx * acz;
    let snz = abx * acy - aby * acx;
    if (sny < 0) {
      snx = -snx;
      sny = -sny;
      snz = -snz;
    }
    const sLen = Math.hypot(snx, sny, snz) || 1;
    sink.addQuad(
      ax, ay, az,
      bx, by, bz,
      cx, cy, cz,
      dx, dy, dz,
      u0, 0, u1, 0, u1, innerHeight - base, u0, innerHeight - base,
      snx / sLen, sny / sLen, snz / sLen, standSurface,
    );
  }

  // Inner rim wall: faces the pitch (inward = -outward).
  let uInner = 0;
  for (let i = 0; i < n; i++) {
    const q0 = inner[i];
    const q1 = inner[(i + 1) % n];
    const len = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
    const u0 = uInner;
    const u1 = uInner + len;
    uInner = u1;
    if (len < 1e-3) continue;
    const [nlx, nly] = boundaryNormalLocal(innerRing, i);
    sink.addQuad(
      q0[0], base, -q0[1],
      q1[0], base, -q1[1],
      q1[0], innerHeight, -q1[1],
      q0[0], innerHeight, -q0[1],
      u0, 0, u1, 0, u1, innerHeight - base, u0, innerHeight - base,
      -nlx, 0, nly, innerWall,
    );
  }

  // Pitch: flat green face inside the inner ring, slightly above ground.
  const pitch = triangulatePolygon([inner]);
  for (const triangle of pitch.triangles) {
    const { a, b, c } = triangle;
    const signed = triangleSignedArea(a, b, c);
    if (Math.abs(signed) < 1e-6) continue;
    const ax = a[0];
    const az = -a[1];
    const bx = b[0];
    const bz = -b[1];
    const cx = c[0];
    const cz = -c[1];
    if (signed > 0) {
      sink.addTriangle(ax, fieldHeight, az, bx, fieldHeight, bz, cx, fieldHeight, cz, 0, 1, 0, a[0], a[1], b[0], b[1], c[0], c[1], pitchSurface);
    } else {
      sink.addTriangle(ax, fieldHeight, az, cx, fieldHeight, cz, bx, fieldHeight, bz, 0, 1, 0, a[0], a[1], c[0], c[1], b[0], b[1], pitchSurface);
    }
  }
}

/**
 * Convert a grandstand volume into a low blank stand with a sloped top.
 * Returns the volume to mesh plus the blank-flag style variant.
 */
export function grandstandVolume(
  volume: BuildingVolume,
  style: BuildingStyle,
): { volume: BuildingVolume; style: BuildingStyle } {
  const points = cleanRing(volume.footprint?.[0]);
  const rect = points.length >= 3 ? minAreaRect(points) : null;
  // Slope across the short side so the stand reads as a rake.
  const direction = rect ? Math.atan2(rect.ux, -rect.uy) : 0;
  const shortSide = rect ? rect.halfWidth * 2 : 12;
  const rise = Math.min(5, Math.max(1.5, shortSide * 0.28));
  const height = Math.min(volume.height, volume.minHeight + 12);
  return {
    volume: {
      ...volume,
      height: Math.max(volume.minHeight + 0.5, height),
      roofShape: 'skillion',
      roofHeight: rise,
      roofDirection: direction,
    },
    style: { ...style, flags: style.flags | STYLE_FLAG.blank },
  };
}
