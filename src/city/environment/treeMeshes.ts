/**
 * Deterministic stylised trees, merged into one indexed vertex-coloured
 * geometry per tile.
 *
 * Each tree is a low-poly tapered trunk (4-sided) plus a stacked "voxel-ish"
 * canopy of flat-shaded boxes with alternating 45° yaws. The look is
 * deliberately blocky so it reads at pixel-art resolution from the isometric
 * camera. Detail is tiered by the number of trees on the tile so a dense park
 * tile stays within the triangle budget:
 *
 *   full   (<=160 trees) : 3 box layers + trunk = 38 triangles/tree
 *   lod    (<=320 trees) : 2 box layers + trunk = 28
 *   simple (<=600 trees) : 1 box layer  + trunk = 18
 *   dense  (>600 trees)  : pyramid canopy + trunk = 12 (forest-scale filler)
 *
 * Every tier stays far below the 60-triangle requirement. No randomness
 * happens at build time: shape, yaw, colour and size all come from the
 * TreeInstance data, so two builds of the same tile are identical.
 *
 * `height` is treated as the nominal tree height (OSM convention, which is what
 * the pipeline emits): the trunk occupies the lower ~42%, the canopy the rest;
 * crown `radius` is the horizontal crown radius.
 */

import * as THREE from 'three';
import { GROUND_LAYER_Y } from '../../shared/config';
import { TREE_COLORS, TREE_TRUNK_COLOR, shadeHex } from '../../engine/materials/palette';
import type { TreeInstance } from '../../shared/types';
import { GeometrySink, type Vec3 } from './meshBuilder';

/** Triangles emitted for one tree at each detail tier. */
export const TREE_TRIANGLES_FULL = 38; // 8 trunk + 3 × 10 canopy
export const TREE_TRIANGLES_LOD = 28; // 8 trunk + 2 × 10 canopy
export const TREE_TRIANGLES_SIMPLE = 18; // 8 trunk + 1 × 10 canopy
export const TREE_TRIANGLES_DENSE = 12; // 8 trunk + 4 pyramid canopy

export type TreeDetailTier = 'full' | 'lod' | 'simple' | 'dense';

/** Tree-count thresholds for the detail tiers (inclusive upper bounds). */
export const TREE_FULL_MAX = 160;
export const TREE_LOD_MAX = 320;
export const TREE_SIMPLE_MAX = 600;

/**
 * Hard safety cap so a pathological tile cannot explode the geometry. Mirrors
 * `MAX_TREES_PER_TILE` in scripts/normalize/trees.py, which thins tiles before
 * they get here; the densest city tile holds ~12 200 trees at full density.
 */
const MAX_TREES_PER_TILE = 16000;

const MIN_TREE_HEIGHT_M = 2;
const MAX_TREE_HEIGHT_M = 40;
const MIN_CROWN_RADIUS_M = 0.45;
const MAX_CROWN_RADIUS_M = 14;
/** Fraction of the total height taken by the trunk. */
const TRUNK_FRACTION = 0.42;

const FULL_LAYER_SIZES = [0.7, 0.52, 0.35] as const;
const FULL_LAYER_HEIGHTS = [0.36, 0.33, 0.31] as const;
const LOD_LAYER_SIZES = [0.7, 0.48] as const;
const LOD_LAYER_HEIGHTS = [0.58, 0.42] as const;
const SIMPLE_LAYER_SIZES = [0.72] as const;
const SIMPLE_LAYER_HEIGHTS = [1] as const;
/** Pyramid canopy (dense tier): base square half-size as a fraction of radius. */
const DENSE_CANOPY_SIZE = 0.92;

export function treeDetailTier(count: number): TreeDetailTier {
  if (count <= TREE_FULL_MAX) return 'full';
  if (count <= TREE_LOD_MAX) return 'lod';
  if (count <= TREE_SIMPLE_MAX) return 'simple';
  return 'dense';
}

export function trianglesForTier(tier: TreeDetailTier): number {
  switch (tier) {
    case 'full':
      return TREE_TRIANGLES_FULL;
    case 'lod':
      return TREE_TRIANGLES_LOD;
    case 'simple':
      return TREE_TRIANGLES_SIMPLE;
    default:
      return TREE_TRIANGLES_DENSE;
  }
}

export interface TreeBuildResult {
  geometry: THREE.BufferGeometry;
  triangleCount: number;
  /** Number of trees actually emitted (invalid instances skipped). */
  count: number;
  /** Detail tier chosen for this tile. */
  tier: TreeDetailTier;
  /** True for every tier except `full` (kept for renderer/diagnostics). */
  lod: boolean;
  /** Triangles per emitted tree for this build. */
  trianglesPerTree: number;
}

/** Build the merged tree geometry, or null when there are no usable trees. */
export function buildTreeGeometry(trees: TreeInstance[] | null | undefined): TreeBuildResult | null {
  if (!Array.isArray(trees) || trees.length === 0) return null;
  const list = trees.slice(0, MAX_TREES_PER_TILE);
  const tier = treeDetailTier(list.length);
  const sink = new GeometrySink();
  let count = 0;
  for (const tree of list) {
    try {
      if (emitTree(sink, tree, tier)) count++;
    } catch {
      // Never let one odd instance break the whole tile.
    }
  }
  if (sink.triangleCount === 0) return null;
  return {
    geometry: sink.build(),
    triangleCount: sink.triangleCount,
    count,
    tier,
    lod: tier !== 'full',
    trianglesPerTree: trianglesForTier(tier),
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function emitTree(
  sink: GeometrySink,
  tree: TreeInstance,
  tier: TreeDetailTier,
): boolean {
  if (!tree) return false;
  const localX = tree.x;
  const localY = tree.y;
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) return false;
  if (!Number.isFinite(tree.height) || !Number.isFinite(tree.radius)) return false;

  const height = clamp(tree.height, MIN_TREE_HEIGHT_M, MAX_TREE_HEIGHT_M);
  const crownRadius = clamp(tree.radius, MIN_CROWN_RADIUS_M, MAX_CROWN_RADIUS_M);
  const variation = Number.isFinite(tree.variation) ? clamp(tree.variation, 0, 1) : 0;

  const baseY = GROUND_LAYER_Y.base;
  const trunkHeight = height * TRUNK_FRACTION;
  const canopyHeight = height - trunkHeight;
  const canopyBase = baseY + trunkHeight;

  // --- trunk: tapered 4-sided prism, top hidden inside the canopy -----------
  const trunkHalfBottom = clamp(crownRadius * 0.055, 0.09, 0.26);
  const trunkHalfTop = trunkHalfBottom * 0.7;
  const trunkTop = canopyBase + canopyHeight * 0.14;
  const trunkColor = shadeHex(TREE_TRUNK_COLOR, -0.06 + variation * 0.08);
  emitTaperedPrism(
    sink,
    localX,
    localY,
    baseY,
    trunkTop,
    trunkHalfBottom,
    trunkHalfTop,
    trunkColor,
  );

  const colorIndex = Math.min(
    TREE_COLORS.length - 1,
    Math.max(0, Math.floor(variation * TREE_COLORS.length)),
  );
  const baseColor = TREE_COLORS[colorIndex] ?? TREE_COLORS[0];
  const baseYaw = variation * Math.PI;

  if (tier === 'dense') {
    // Cheapest tier: a single pyramid canopy (4 triangles) for forest-scale
    // tiles where hundreds of trees share the tile budget.
    emitPyramidCanopy(
      sink,
      localX,
      localY,
      canopyBase,
      baseY + height,
      crownRadius * DENSE_CANOPY_SIZE,
      baseYaw + Math.PI / 4,
      shadeHex(baseColor, -0.02),
    );
    return true;
  }

  const layerSizes =
    tier === 'full' ? FULL_LAYER_SIZES : tier === 'lod' ? LOD_LAYER_SIZES : SIMPLE_LAYER_SIZES;
  const layerHeights =
    tier === 'full' ? FULL_LAYER_HEIGHTS : tier === 'lod' ? LOD_LAYER_HEIGHTS : SIMPLE_LAYER_HEIGHTS;
  let y = canopyBase;
  for (let layer = 0; layer < layerSizes.length; layer++) {
    const layerHeight = canopyHeight * layerHeights[layer];
    const halfSize = crownRadius * layerSizes[layer];
    const yaw = baseYaw + (layer % 2 === 0 ? Math.PI / 4 : 0) + layer * 0.08;
    const brightness = -0.04 + layer * 0.06;
    emitCanopyBox(sink, localX, localY, y, y + layerHeight, halfSize, yaw, shadeHex(baseColor, brightness));
    y += layerHeight;
  }
  return y > baseY;
}

/** Four-triangle pyramid canopy used by the `dense` detail tier. */
function emitPyramidCanopy(
  sink: GeometrySink,
  localX: number,
  localY: number,
  y0: number,
  y1: number,
  halfSize: number,
  yaw: number,
  color: string,
): void {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const unitCorners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const corners: Vec3[] = unitCorners.map(([cx, cy]) => {
    const x = halfSize * (cx * cos - cy * sin);
    const y = halfSize * (cx * sin + cy * cos);
    return [localX + x, y0, -(localY + y)];
  });
  const apex: Vec3 = [localX, y1, -localY];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const midX = (a[0] + b[0]) / 2 - localX;
    const midZ = (a[2] + b[2]) / 2 + localY;
    const length = Math.hypot(midX, midZ) || 1;
    const outward: Vec3 = [midX / length, 0, midZ / length];
    sink.addWorldTriangle(a, b, apex, color, outward);
  }
}

/** Vertical quads of a tapered square trunk. */
function emitTaperedPrism(
  sink: GeometrySink,
  localX: number,
  localY: number,
  y0: number,
  y1: number,
  halfBottom: number,
  halfTop: number,
  color: string,
): void {
  // Square corners in CCW order in local ground coordinates.
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const bottomA: Vec3 = [localX + a[0] * halfBottom, y0, -(localY + a[1] * halfBottom)];
    const bottomB: Vec3 = [localX + b[0] * halfBottom, y0, -(localY + b[1] * halfBottom)];
    const topB: Vec3 = [localX + b[0] * halfTop, y1, -(localY + b[1] * halfTop)];
    const topA: Vec3 = [localX + a[0] * halfTop, y1, -(localY + a[1] * halfTop)];
    const midX = (a[0] + b[0]) / 2;
    const midY = (a[1] + b[1]) / 2;
    const length = Math.hypot(midX, midY) || 1;
    const outward: Vec3 = [midX / length, 0, -midY / length];
    sink.addOrientedQuad(topA, topB, bottomB, bottomA, outward, color);
  }
}

/**
 * One flat-shaded canopy "voxel": a box with a yaw rotation, no bottom face
 * (never visible from the isometric camera) = 10 triangles.
 */
function emitCanopyBox(
  sink: GeometrySink,
  localX: number,
  localY: number,
  y0: number,
  y1: number,
  halfSize: number,
  yaw: number,
  color: string,
): void {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const unitCorners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const corners: [number, number][] = unitCorners.map(([cx, cy]) => [
    halfSize * (cx * cos - cy * sin),
    halfSize * (cx * sin + cy * cos),
  ]);

  const at = (corner: [number, number], height: number, dx: number, dy: number): Vec3 => [
    localX + corner[0] + dx,
    height,
    -(localY + corner[1] + dy),
  ];

  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const topA = at(a, y1, 0, 0);
    const topB = at(b, y1, 0, 0);
    const bottomB = at(b, y0, 0, 0);
    const bottomA = at(a, y0, 0, 0);
    const midX = (a[0] + b[0]) / 2;
    const midY = (a[1] + b[1]) / 2;
    const length = Math.hypot(midX, midY) || 1;
    const outward: Vec3 = [midX / length, 0, -midY / length];
    sink.addOrientedQuad(topA, topB, bottomB, bottomA, outward, color);
  }

  // Top face: unit corners are CCW in local ground space => +Y in world space.
  const topCorners: Vec3[] = corners.map((corner) => at(corner, y1, 0, 0));
  sink.addOrientedQuad(topCorners[0], topCorners[1], topCorners[2], topCorners[3], [0, 1, 0], color);
}
