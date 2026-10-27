/**
 * Indexed vertex-colour geometry accumulator shared by the environment builders.
 *
 * One sink collects every triangle of a category (ground, roads, trees) into a
 * single indexed `BufferGeometry` so the renderer draws one mesh per category
 * per tile, not one per polygon.
 *
 * Vertex attributes:
 *  - `position` : world space metres, `[x, height, -y]` (see shared/types.ts)
 *  - `normal`   : flat face normal (up for horizontal layers, outward for
 *                 bridge skirts / tree faces)
 *  - `color`    : linear-space vertex colour, consumed by Three's standard
 *                 `vertexColors` path (the environment material may not
 *                 multiply a second custom attribute on top — see the
 *                 renderer/facades integration note in environmentMeshes.ts).
 *
 * All flat layer triangles are forced counter-clockwise in local space, which
 * maps to a +Y normal in world space.
 */

import * as THREE from 'three';
import type { Point2, Triangle2 } from './triangulate';

export type Vec3 = [number, number, number];

/** Minimum cross-product length² for a triangle to be considered non-degenerate. */
const MIN_CROSS_SQ = 1e-10;

export class GeometrySink {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private indices: number[] = [];
  private colorCache = new Map<string, readonly [number, number, number]>();

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get isEmpty(): boolean {
    return this.indices.length === 0;
  }

  /** Linear-space RGB for an sRGB hex colour, cached per hex. */
  colorOf(hex: string): readonly [number, number, number] {
    let color = this.colorCache.get(hex);
    if (!color) {
      const threeColor = new THREE.Color(hex).convertSRGBToLinear();
      color = [threeColor.r, threeColor.g, threeColor.b];
      this.colorCache.set(hex, color);
    }
    return color;
  }

  /** Add all triangles of a prepared flat polygon at height `y`. */
  addFlatTriangles(triangles: readonly Triangle2[], y: number, hex: string): number {
    let added = 0;
    for (const triangle of triangles) {
      if (
        this.addFlatTriangle(
          triangle[0][0],
          triangle[0][1],
          triangle[1][0],
          triangle[1][1],
          triangle[2][0],
          triangle[2][1],
          y,
          hex,
        )
      ) {
        added++;
      }
    }
    return added;
  }

  /** Add one horizontal triangle from local-metre coordinates. */
  addFlatTriangle(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    y: number,
    hex: string,
  ): boolean {
    if (
      !Number.isFinite(ax) ||
      !Number.isFinite(ay) ||
      !Number.isFinite(bx) ||
      !Number.isFinite(by) ||
      !Number.isFinite(cx) ||
      !Number.isFinite(cy) ||
      !Number.isFinite(y)
    ) {
      return false;
    }
    let cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!Number.isFinite(cross) || Math.abs(cross) < MIN_CROSS_SQ) return false;
    // Force CCW in local space => +Y in world space.
    const points: [number, number][] =
      cross > 0
        ? [
            [ax, ay],
            [bx, by],
            [cx, cy],
          ]
        : [
            [ax, ay],
            [cx, cy],
            [bx, by],
          ];
    return this.addHorizontalVertices(points, y, hex);
  }

  /**
   * Add a horizontal quad from local-metre corners in ring order. Winding is
   * normalised automatically; a self-intersecting/zero-area quad is skipped.
   */
  addFlatQuad(p0: Point2, p1: Point2, p2: Point2, p3: Point2, y: number, hex: string): boolean {
    if (!Number.isFinite(y)) return false;
    let area =
      (p0[0] * p1[1] - p1[0] * p0[1]) +
      (p1[0] * p2[1] - p2[0] * p1[1]) +
      (p2[0] * p3[1] - p3[0] * p2[1]) +
      (p3[0] * p0[1] - p0[0] * p3[1]);
    area *= 0.5;
    if (!Number.isFinite(area) || Math.abs(area) < MIN_CROSS_SQ) return false;
    const corners: Point2[] =
      area > 0 ? [p0, p1, p2, p3] : [p0, p3, p2, p1];
    for (const [x, yy] of corners) {
      if (!Number.isFinite(x) || !Number.isFinite(yy)) return false;
    }
    const cross = (corners[1][0] - corners[0][0]) * (corners[2][1] - corners[0][1]) -
      (corners[1][1] - corners[0][1]) * (corners[2][0] - corners[0][0]);
    if (!Number.isFinite(cross) || Math.abs(cross) < MIN_CROSS_SQ) return false;
    const base = this.vertexCount;
    const color = this.colorOf(hex);
    for (const [x, yy] of corners) {
      this.positions.push(x, y, -yy);
      this.normals.push(0, 1, 0);
      this.colors.push(color[0], color[1], color[2]);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return true;
  }

  private addHorizontalVertices(points: readonly Point2[], y: number, hex: string): boolean {
    const base = this.vertexCount;
    const color = this.colorOf(hex);
    for (const [x, yy] of points) {
      this.positions.push(x, y, -yy);
      this.normals.push(0, 1, 0);
      this.colors.push(color[0], color[1], color[2]);
    }
    this.indices.push(base, base + 1, base + 2);
    return true;
  }

  /**
   * Add a quad in world space with an explicit desired facing direction. Used
   * for vertical bridge skirts and stylised tree faces. The order of the four
   * points is normalised so the face points along `desired`.
   */
  addOrientedQuad(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Vec3,
    desired: Vec3,
    hex: string,
  ): boolean {
    if (
      !isFiniteVec(a) ||
      !isFiniteVec(b) ||
      !isFiniteVec(c) ||
      !isFiniteVec(d) ||
      !isFiniteVec(desired)
    ) {
      return false;
    }
    let normal = crossVec(subVec(b, a), subVec(c, a));
    if (lengthSq(normal) < MIN_CROSS_SQ) normal = crossVec(subVec(c, a), subVec(d, a));
    if (lengthSq(normal) < MIN_CROSS_SQ) return false;
    if (dotVec(normal, desired) < 0) {
      const ordered: Vec3[] = [a, d, c, b];
      return this.emitWorldQuad(ordered[0], ordered[1], ordered[2], ordered[3], scaleVec(normal, -1), hex);
    }
    return this.emitWorldQuad(a, b, c, d, normal, hex);
  }

  private emitWorldQuad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, normal: Vec3, hex: string): boolean {
    const unit = normalizeVec(normal);
    if (!unit) return false;
    // Split into two triangles; drop the second if it collapses.
    if (!this.emitWorldTriangle(a, b, c, unit, hex)) return false;
    const cross2 = crossVec(subVec(c, a), subVec(d, a));
    if (lengthSq(cross2) >= MIN_CROSS_SQ) {
      this.emitWorldTriangle(a, c, d, normalizeVec(cross2) ?? unit, hex);
    }
    return true;
  }

  /** Add a world-space triangle with an explicit normal. */
  addWorldTriangle(a: Vec3, b: Vec3, c: Vec3, hex: string, desiredNormal?: Vec3): boolean {
    if (!isFiniteVec(a) || !isFiniteVec(b) || !isFiniteVec(c)) return false;
    const cross = crossVec(subVec(b, a), subVec(c, a));
    if (lengthSq(cross) < MIN_CROSS_SQ) return false;
    let normal = normalizeVec(cross);
    if (!normal) return false;
    if (desiredNormal && dotVec(normal, desiredNormal) < 0) {
      normal = scaleVec(normal, -1);
      const tmp = b;
      b = c;
      c = tmp;
    }
    return this.emitWorldTriangle(a, b, c, normal, hex);
  }

  /** Add a world-space triangle with a known unit normal. */
  emitWorldTriangle(a: Vec3, b: Vec3, c: Vec3, normal: Vec3, hex: string): boolean {
    if (
      !isFiniteVec(a) ||
      !isFiniteVec(b) ||
      !isFiniteVec(c) ||
      !isFiniteVec(normal)
    ) {
      return false;
    }
    const base = this.vertexCount;
    const color = this.colorOf(hex);
    for (const point of [a, b, c]) {
      this.positions.push(point[0], point[1], point[2]);
      this.normals.push(normal[0], normal[1], normal[2]);
      this.colors.push(color[0], color[1], color[2]);
    }
    this.indices.push(base, base + 1, base + 2);
    return true;
  }

  /** Finalise into one indexed geometry. Safe (empty) when nothing was added. */
  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const positionArray = new Float32Array(this.positions);
    const normalArray = new Float32Array(this.normals);
    const colorArray = new Float32Array(this.colors);

    geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normalArray, 3));
    // Standard Three.js vertex-colour attribute (linear RGB values). The
    // environment material is expected to use `vertexColors: true` only; it
    // must NOT multiply a second custom colour attribute on top of this.
    geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));

    if (this.indices.length > 0) {
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(this.indices), 1));
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
    } else {
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(0), 1));
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
      geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    }
    return geometry;
  }
}

function subVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function crossVec(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dotVec(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function lengthSq(vec: Vec3): number {
  return vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2];
}

function scaleVec(vec: Vec3, factor: number): Vec3 {
  return [vec[0] * factor, vec[1] * factor, vec[2] * factor];
}

function normalizeVec(vec: Vec3): Vec3 | null {
  const length = Math.sqrt(lengthSq(vec));
  if (!Number.isFinite(length) || length < 1e-9) return null;
  return [vec[0] / length, vec[1] / length, vec[2] / length];
}

function isFiniteVec(vec: Vec3): boolean {
  return Number.isFinite(vec[0]) && Number.isFinite(vec[1]) && Number.isFinite(vec[2]);
}
