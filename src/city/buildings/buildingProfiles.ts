/**
 * Bounded, source-preserving massing profiles.
 *
 * A profile never invents mass: it redistributes the declared envelope by
 * lowering eligible wall segments while keeping the source maximum height and
 * the original footprint. The output of this module is still one or more
 * `BuildingVolume`s whose union is a subset of the source plan area and whose
 * top never exceeds `source.height + PROFILE_EPS_M`.
 *
 * Eligibility is deliberately conservative:
 *  - explicit `building:part` topology always wins (the caller passes
 *    `hasExplicitParts` and the profile returns unchanged volumes);
 *  - courtyard / holed footprints and concave rings keep the base profile;
 *  - only convex single rings are split, by a half-plane along the minimum-area
 *    rectangle's long axis, so every output piece is a simple capped prism.
 *
 * The profile is an implementation detail of the *near* representation; the far
 * representation is exported from the same styled source metadata (see
 * `scripts/normalize/export_far.py`), never by re-creating generic slabs.
 */

import type { BuildingVolume, Polygon, Ring, RoofShape } from '../../shared/types';
import type { StyleRecipe } from '../../shared/buildingStyles';
import { clipHalfPlane, type HalfPlane } from '../roofs/envelope';
import { minAreaRect, polygonCentroid, signedArea, type Point2 } from './polygon2d';

/** Tolerance for the preserved maximum height (design §8). */
export const PROFILE_EPS_M = 0.05;
/** Fraction of the long side kept at full height for an end pavilion. */
const END_PAVILION_PRESERVED = 0.38;
/** Height drop of the non-preserved end pavilion wing, metres. */
const END_PAVILION_DROP_M = 1.4;
/** Fraction of the long side kept at full height for a stepped profile. */
const STEPPED_PRESERVED = 0.58;
/** Height drop of the stepped rear block, fraction of the source height. */
const STEPPED_DROP_RATIO = 0.16;
/** Minimum footprint area for any profile split (m²). */
const MIN_PROFILE_AREA_M2 = 60;
/** Minimum long side for any profile split (m). */
const MIN_PROFILE_LONG_SIDE_M = 12;

export interface GeometryBuildContext {
  readonly recipe: StyleRecipe;
  readonly detailLevel: 'far' | 'near';
  readonly seed: number;
  /** True when the building carries explicit `building:part` volumes. */
  readonly hasExplicitParts?: boolean;
  /** Source total height (top of the main volume); the profile never exceeds it. */
  readonly sourceHeight?: number;
}

export interface VolumeProfile {
  readonly volumes: BuildingVolume[];
  readonly changed: boolean;
  /** Profile name actually applied (`base` when unchanged). */
  readonly profile: 'base' | 'frame' | 'end_pavilion' | 'stepped';
  /** Why the requested profile was skipped (audit only). */
  readonly reason?: string;
}

/** True when a recipe asks for a massing change at all. */
export function recipeSupportsProfile(recipe: StyleRecipe): boolean {
  return recipe.profile === 'end_pavilion' || recipe.profile === 'stepped';
}

function ringsOf(polygon: Polygon | undefined): Point2[][] {
  if (!Array.isArray(polygon)) return [];
  const rings: Point2[][] = [];
  for (const ring of polygon) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const points: Point2[] = [];
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [x, y] = point;
      if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
    }
    if (points.length >= 3) rings.push(points);
  }
  return rings;
}

function isConvex(points: readonly Point2[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const c = points[(i + 2) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const current = Math.sign(cross);
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return sign !== 0;
}

function areaOf(points: readonly Point2[]): number {
  return Math.abs(signedArea(points as Point2[]));
}

function toRing(points: readonly Point2[]): Ring {
  return points.map(([x, y]) => [round(x), round(y)] as [number, number]);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clip(points: readonly Point2[], plane: HalfPlane): Point2[] {
  return clipHalfPlane(points, plane);
}

/** Build one profile piece from a clipped ring, keeping the source metadata. */
function pieceVolume(
  base: BuildingVolume,
  points: Point2[],
  top: number,
  minHeight: number,
  roofShape: RoofShape = 'flat',
  roofHeight = 0,
): BuildingVolume {
  return {
    ...base,
    footprint: [toRing(points)],
    minHeight: round(minHeight),
    height: round(Math.max(minHeight + 0.5, Math.min(top, base.height))),
    roofShape,
    roofHeight: roofShape === 'flat' ? 0 : round(roofHeight),
  };
}

interface SplitAxis {
  /** Split fraction along the long axis (0..1). */
  fraction: number;
  /** Long-axis unit vector. */
  ux: number;
  uy: number;
  /** Projected coordinate of the split line along (ux, uy). */
  line: number;
}

function splitAxisFor(points: readonly Point2[], fraction: number): SplitAxis | null {
  const rect = minAreaRect(points as Point2[]);
  if (!rect) return null;
  const longSide = rect.halfLength * 2;
  const shortSide = rect.halfWidth * 2;
  if (!(longSide >= MIN_PROFILE_LONG_SIDE_M) || !(shortSide >= 3)) return null;
  let ux = rect.ux;
  let uy = rect.uy;
  // minAreaRect exposes (ux, uy) along halfLength; keep the long axis direction.
  const length = Math.hypot(ux, uy);
  if (!(length > 1e-9)) return null;
  ux /= length;
  uy /= length;
  const centre = polygonCentroid([points as Point2[]]);
  const centreU = centre[0] * ux + centre[1] * uy;
  const line = centreU + (fraction - 0.5) * longSide;
  return { fraction, ux, uy, line };
}

/**
 * Apply the recipe's massing profile to the source volumes.
 *
 * Returns the input volumes unchanged (and `changed: false`) whenever the
 * request is ineligible. Never throws for sane input.
 */
export function profileVolumes(
  volumes: readonly BuildingVolume[],
  context: GeometryBuildContext,
): VolumeProfile {
  const unchanged = (reason?: string): VolumeProfile => ({
    volumes: [...volumes],
    changed: false,
    profile: 'base',
    ...(reason ? { reason } : {}),
  });

  if (context.detailLevel === 'far') return unchanged('far representation');
  if (context.hasExplicitParts) return unchanged('explicit building:part topology');
  if (!recipeSupportsProfile(context.recipe)) return unchanged('recipe keeps the source massing');
  if (!Array.isArray(volumes) || volumes.length === 0) return unchanged('no volumes');

  const profile = context.recipe.profile;
  const next: BuildingVolume[] = [];
  let changed = false;

  for (const volume of volumes) {
    const rings = ringsOf(volume.footprint);
    if (rings.length !== 1) {
      next.push(volume);
      continue;
    }
    const exterior = rings[0];
    if (!isConvex(exterior)) {
      next.push(volume);
      continue;
    }
    const area = areaOf(exterior);
    if (!(area >= MIN_PROFILE_AREA_M2)) {
      next.push(volume);
      continue;
    }
    const wallTop = volume.height;
    const wallBottom = volume.minHeight;
    const wallHeight = wallTop - wallBottom;
    if (!(wallHeight >= 4)) {
      next.push(volume);
      continue;
    }
    // Roofed volumes keep their roof on the preserved piece only: the lowered
    // piece gets a flat cap, so no invented sloped roof appears above the source.
    const roofed = volume.roofShape !== 'flat' && volume.roofHeight > 0.05;

    if (profile === 'end_pavilion') {
      const axis = splitAxisFor(exterior, END_PAVILION_PRESERVED);
      if (!axis) {
        next.push(volume);
        continue;
      }
      const drop = Math.min(END_PAVILION_DROP_M, Math.max(0.8, wallHeight * 0.12));
      const preservedPlane: HalfPlane = {
        a: -axis.ux,
        b: -axis.uy,
        c: axis.line,
      };
      const loweredPlane: HalfPlane = { a: axis.ux, b: axis.uy, c: -axis.line };
      const preserved = clip(exterior, preservedPlane);
      const lowered = clip(exterior, loweredPlane);
      if (preserved.length < 3 || lowered.length < 3) {
        next.push(volume);
        continue;
      }
      if (areaOf(preserved) < MIN_PROFILE_AREA_M2 * 0.25 || areaOf(lowered) < MIN_PROFILE_AREA_M2 * 0.25) {
        next.push(volume);
        continue;
      }
      next.push(
        pieceVolume(
          volume,
          preserved,
          wallTop,
          wallBottom,
          roofed ? volume.roofShape : 'flat',
          roofed ? volume.roofHeight : 0,
        ),
        pieceVolume(volume, lowered, wallTop - drop, wallBottom),
      );
      changed = true;
      continue;
    }

    if (profile === 'stepped') {
      const axis = splitAxisFor(exterior, STEPPED_PRESERVED);
      if (!axis) {
        next.push(volume);
        continue;
      }
      const drop = Math.max(1.0, wallHeight * STEPPED_DROP_RATIO);
      const frontPlane: HalfPlane = { a: -axis.ux, b: -axis.uy, c: axis.line };
      const rearPlane: HalfPlane = { a: axis.ux, b: axis.uy, c: -axis.line };
      const front = clip(exterior, frontPlane);
      const rear = clip(exterior, rearPlane);
      if (front.length < 3 || rear.length < 3) {
        next.push(volume);
        continue;
      }
      if (areaOf(front) < MIN_PROFILE_AREA_M2 * 0.25 || areaOf(rear) < MIN_PROFILE_AREA_M2 * 0.25) {
        next.push(volume);
        continue;
      }
      next.push(
        pieceVolume(
          volume,
          front,
          wallTop,
          wallBottom,
          roofed ? volume.roofShape : 'flat',
          roofed ? volume.roofHeight : 0,
        ),
        pieceVolume(volume, rear, wallTop - drop, wallBottom),
      );
      changed = true;
      continue;
    }

    next.push(volume);
  }

  if (!changed) return unchanged('profile split not applicable');

  // The preserved maximum must stay the source maximum (within tolerance).
  const sourceTop = Math.max(...volumes.map((volume) => volume.height));
  const profiledTop = Math.max(...next.map((volume) => volume.height));
  if (profiledTop > sourceTop + PROFILE_EPS_M) return unchanged('profile would exceed the source height');

  return { volumes: next, changed: true, profile };
}
