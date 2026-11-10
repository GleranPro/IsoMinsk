/** Compact, deterministic vegetation. No per-tree vertices are built in workers. */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TreeInstance } from '../../shared/types';
import { GROUND_LAYER_Y } from '../../shared/config';
import { treeDetailTier, type TreeDetailTier } from './treeMeshes';

export const TREE_STYLES = ['faceted', 'clustered', 'asymmetric'] as const;
export type TreeStyle = (typeof TREE_STYLES)[number];
/** Legacy is retained only as an explicit QA comparison path. */
export type TreeRenderStyle = 'legacy' | TreeStyle;
export const MAX_INSTANCED_TREES_PER_TILE = 16000;
export const CANOPY_PALETTE = ['#52783c', '#648749', '#73944f', '#456b36'] as const;

export interface TreeInstanceBatch {
  template: number;
  count: number;
  matrices: Float32Array;
  colors: Float32Array;
  /** Kept for recolouring without fetching or rebuilding tiles. */
  variations: Float32Array;
}

export interface TreeInstances {
  style: TreeStyle;
  tier: TreeDetailTier;
  count: number;
  triangleCount: number;
  trunks: TreeInstanceBatch;
  crowns: TreeInstanceBatch[];
}

export function resolveTreeStyle(value: string | null | undefined): TreeRenderStyle {
  if (value === 'legacy') return 'legacy';
  return TREE_STYLES.includes(value as TreeStyle) ? value as TreeStyle : 'asymmetric';
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const noise = (v: number, salt: number) => {
  const n = Math.sin(v * 173.13 + salt * 91.71) * 43758.5453;
  return n - Math.floor(n);
};

export function canopyColor(variation: number, palette: readonly string[] = CANOPY_PALETTE): THREE.Color {
  const i = Math.min(palette.length - 1, Math.floor(variation * palette.length));
  return new THREE.Color(palette[i]).multiplyScalar(0.93 + noise(variation, 4) * 0.14);
}

export function crownTriangles(style: TreeStyle, tier: TreeDetailTier): number {
  if (tier === 'dense') return style === 'faceted' ? 8 : style === 'asymmetric' ? 20 : 16;
  if (tier === 'simple') return style === 'faceted' ? 20 : 28;
  if (tier === 'lod') return style === 'faceted' ? 20 : 36;
  return style === 'faceted' ? 32 : style === 'clustered' ? 44 : 48;
}

function batch(template: number, count: number): TreeInstanceBatch {
  return { template, count, matrices: new Float32Array(count * 16),
    colors: new Float32Array(count * 3), variations: new Float32Array(count) };
}

/** Keep nominal total height and crown radius; only the silhouette changes. */
export function buildTreeInstances(
  trees: TreeInstance[] | null | undefined,
  style: TreeStyle,
): TreeInstances | null {
  if (!Array.isArray(trees) || trees.length === 0) return null;
  const capped = trees.slice(0, MAX_INSTANCED_TREES_PER_TILE);
  // Match the existing density policy, including invalid entries in its tier decision.
  const tier = treeDetailTier(capped.length);
  const valid = capped.filter(t => t && [t.x, t.y, t.height, t.radius].every(Number.isFinite));
  if (!valid.length) return null;
  const variations = valid.map(t => Math.fround(Number.isFinite(t.variation) ? clamp(t.variation, 0, 1) : 0));
  // Forest tiles contain 97% of the city trees. At this tier the three variants
  // share one silhouette; per-tree yaw and proportions retain the variation.
  // Keeping one crown batch avoids 218 extra city-wide draw calls.
  const variants = variations.map(v => tier === 'dense' ? 0 : Math.min(2, Math.floor(noise(v, 7) * 3)));
  const trunks = batch(0, valid.length);
  const crowns = [0, 1, 2].map(id => batch(id, variants.filter(v => v === id).length));
  const offsets = [0, 0, 0];
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < valid.length; i++) {
    const t = valid[i], v = variations[i];
    const height = clamp(t.height, 2, 40), radius = clamp(t.radius, 0.45, 14);
    const width = clamp(radius * 0.055, 0.09, 0.26);
    position.set(t.x, GROUND_LAYER_Y.base, -t.y);
    scale.set(width, height * 0.53, width);
    matrix.compose(position, rotation.identity(), scale).toArray(trunks.matrices, i * 16);
    new THREE.Color('#71553b').multiplyScalar(0.9 + v * 0.16).toArray(trunks.colors, i * 3);
    trunks.variations[i] = v;
    const target = crowns[variants[i]], j = offsets[variants[i]]++;
    position.y += height * 0.34;
    scale.set(radius * (0.88 + noise(v, 1) * 0.12), height * 0.66,
      radius * (0.86 + noise(v, 2) * 0.14));
    rotation.setFromAxisAngle(up, v * Math.PI * 2);
    matrix.compose(position, rotation, scale).toArray(target.matrices, j * 16);
    canopyColor(v).toArray(target.colors, j * 3);
    target.variations[j] = v;
  }
  return { style, tier, count: valid.length, trunks, crowns: crowns.filter(b => b.count > 0),
    triangleCount: valid.length * (8 + crownTriangles(style, tier)) };
}

/** One unit tapered trunk, open ends hidden by the ground and crown. */
export function createTrunkTemplate(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.7, 1, 1, 4, 1, true);
  geometry.rotateY(Math.PI / 4);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

type Lobe = [x: number, y: number, z: number, sx: number, sy: number, sz: number, detail: 'ico' | 'octa'];

/** Flat-shaded shared template; each style has three repeatable silhouettes. */
export function createCrownTemplate(style: TreeStyle, tier: TreeDetailTier, variant: number): THREE.BufferGeometry {
  let lobes: Lobe[];
  const skew = (variant - 1) * 0.12;
  if (tier === 'dense' && style === 'faceted') {
    lobes = [[skew, 0.5, 0, 1, 0.5, 0.86 + variant * 0.07, 'octa']];
  } else if (tier === 'dense' && style === 'asymmetric') {
    // A rounded, broad silhouette like the summer reference, not two pointed diamonds.
    lobes = [[skew, 0.5, 0, 1, 0.57, 0.87 + variant * 0.04, 'ico']];
  } else if (tier === 'dense') {
    lobes = [[-0.28, 0.43, 0, 0.77, 0.44, 0.82, 'octa'],
      [0.32, style === 'asymmetric' ? 0.72 : 0.61, skew, 0.67, 0.36, 0.73, 'octa']];
  } else if (style === 'faceted') {
    if (tier === 'full') return facetedCrown(variant);
    lobes = [[skew, 0.5, 0, 1, 0.55, 0.9, 'ico']];
  } else if (tier === 'simple') {
    lobes = [[-0.28, 0.43, 0, 0.77, 0.44, 0.82, 'ico'],
      [0.32, 0.64, skew, 0.67, 0.36, 0.73, 'octa']];
  } else if (style === 'clustered') {
    lobes = [[0, 0.54, 0, 0.86, 0.48, 0.83, 'ico'],
      [-0.46, 0.42, 0.18 + skew, 0.62, 0.35, 0.64, 'octa'],
      [0.47, 0.47 + skew, -0.12, 0.62, 0.37, 0.63, 'octa']];
    if (tier === 'full') lobes.push([skew, 0.75, -0.34, 0.59, 0.31, 0.58, 'octa']);
  } else {
    lobes = [[-0.3, 0.46, 0, 0.75, 0.42, 0.83, 'ico'],
      [0.4, 0.68, -0.08 + skew, 0.65, 0.36, 0.64, tier === 'full' ? 'ico' : 'octa'],
      [0.13, 0.3, 0.42, 0.65, 0.27, 0.58, 'octa']];
  }
  const positions: number[] = [], colors: number[] = [];
  lobes.forEach(([x, y, z, sx, sy, sz, detail], lobe) => {
    const geometry = detail === 'ico' ? new THREE.IcosahedronGeometry(1, 0) : new THREE.OctahedronGeometry(1, 0);
    geometry.scale(sx, sy, sz);
    geometry.translate(x, y, z);
    const p = geometry.getAttribute('position');
    const brightness = 0.9 + lobe * 0.065;
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      colors.push(brightness, brightness, brightness);
    }
    geometry.dispose();
  });
  return finishCrown(positions, colors);
}

function facetedCrown(variant: number): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [];
  const ring = (i: number, upper: boolean): number[] => {
    const angle = i * Math.PI / 4;
    const r = (upper ? 0.83 : 1) * (1 + Math.sin(i * 2.7 + variant * 1.9) * 0.12);
    return [Math.cos(angle) * r + (upper ? 0.09 * (variant - 1) : 0), upper ? 0.7 : 0.28, Math.sin(angle) * r];
  };
  for (let i = 0; i < 8; i++) {
    const a = ring(i, false), b = ring(i + 1, false), c = ring(i, true), d = ring(i + 1, true);
    // Outward winding around the vertical axis.
    for (const triangle of [[[0, 0, 0], b, a], [a, b, d], [a, d, c], [c, d, [0, 1, 0]]]) {
      positions.push(...triangle.flat());
      const shade = 0.94 + (i % 3) * 0.045;
      for (let k = 0; k < 3; k++) colors.push(shade, shade, shade);
    }
  }
  // The ring uses +Z as its second horizontal axis, so reverse the faces.
  for (let i = 0; i < positions.length; i += 9) {
    for (let j = 0; j < 3; j++) [positions[i + 3 + j], positions[i + 6 + j]] = [positions[i + 6 + j], positions[i + 3 + j]];
  }
  return finishCrown(positions, colors);
}

function finishCrown(positions: number[], colors: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const centerX = (bounds.min.x + bounds.max.x) / 2, centerZ = (bounds.min.z + bounds.max.z) / 2;
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3) radius = Math.max(radius, Math.hypot(positions[i] - centerX, positions[i + 2] - centerZ));
  const h = bounds.max.y - bounds.min.y;
  geometry.translate(-centerX, -bounds.min.y, -centerZ);
  geometry.scale(1 / radius, 1 / h, 1 / radius);
  // Lambert flatShading derives face normals in the fragment shader. Share the
  // position/colour vertices instead of transforming three copies per triangle.
  // Omitting normals during welding also keeps neighbouring faces indexed.
  const indexed = mergeVertices(geometry);
  geometry.dispose();
  indexed.computeVertexNormals();
  indexed.computeBoundingBox();
  indexed.computeBoundingSphere();
  return indexed;
}

export function treeInstanceBytes(trees: TreeInstances | null | undefined): number {
  return trees ? [trees.trunks, ...trees.crowns].reduce((n, b) => n + b.matrices.byteLength + b.colors.byteLength + b.variations.byteLength, 0) : 0;
}
