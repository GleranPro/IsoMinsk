/**
 * MeshSink — one merged, indexed BufferGeometry for an entire tile.
 *
 * All building geometry for a tile is accumulated into growing typed arrays and
 * converted to a single THREE.BufferGeometry at the end. No per-building THREE
 * objects are created, which keeps draw calls at one per tile and avoids GC
 * churn while streaming tiles.
 *
 * Performance notes:
 *  - Wall quads are emitted with 4 shared vertices (indexed, two triangles from
 *    the same corner), so attribute data is written once per corner rather than
 *    once per triangle. Roof facets are emitted as independent triangles
 *    because each clipped facet is small.
 *  - `finish()` hands out subarray views of the internally grown typed arrays
 *    instead of copying; the renderer uploads only the view bounds.
 *
 * World space convention (see src/shared/config.ts, types.ts):
 *     world = (localX, heightMetres, -localY)
 *
 * Vertex attributes follow src/shared/geometry.ts exactly.
 */

import * as THREE from 'three';
import { FACE_KIND } from '../../shared/geometry';

export type RGB = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];

/** Vertex attribute payload shared by every triangle of one surface. */
export interface SurfaceStyle {
  /** Index into BuildingMeshResult.buildingIds. */
  owner: number;
  /** sRGB base colour 0..1. */
  color: RGB;
  /** aStyle: archetype id, floor height, ground floor height, seed. */
  style: Vec4;
  /** aFace: face kind, style flags, trim intensity, detail hint / roof id. */
  face: Vec4;
}

export interface MeshSinkResult {
  geometry: THREE.BufferGeometry;
  triangleOwner: Uint32Array;
  triangleCount: number;
}

const INITIAL_VERTICES = 8192;
const INITIAL_TRIANGLES = 4096;

export class MeshSink {
  private positions = new Float32Array(INITIAL_VERTICES * 3);
  private normals = new Float32Array(INITIAL_VERTICES * 3);
  private uvs = new Float32Array(INITIAL_VERTICES * 2);
  private colors = new Float32Array(INITIAL_VERTICES * 3);
  private styles = new Float32Array(INITIAL_VERTICES * 4);
  private faces = new Float32Array(INITIAL_VERTICES * 4);

  private indices = new Uint32Array(INITIAL_TRIANGLES * 3);
  private owners = new Uint32Array(INITIAL_TRIANGLES);

  private vertexCount = 0;
  private triangleCount = 0;

  /** Number of triangles rejected as degenerate or non-finite. */
  skippedTriangles = 0;

  /** First rejected triangle's raw inputs, for diagnostics. */
  firstNonFinite: number[] | null = null;

  private recordNonFinite(values: number[], count: number): void {
    this.skippedTriangles += count;
    if (!this.firstNonFinite) this.firstNonFinite = values.slice();
  }

  private minX = Infinity;
  private minY = Infinity;
  private minZ = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private maxZ = -Infinity;

  get triangles(): number {
    return this.triangleCount;
  }

  get vertices(): number {
    return this.vertexCount;
  }

  /** Ensure capacity for `count` more vertices; returns false on non-finite growth. */
  private ensureVertices(count: number): void {
    if ((this.vertexCount + count) * 3 > this.positions.length) {
      let capacity = this.positions.length / 3;
      while (capacity < this.vertexCount + count) capacity *= 2;
      const positions = new Float32Array(capacity * 3);
      positions.set(this.positions);
      this.positions = positions;
      const normals = new Float32Array(capacity * 3);
      normals.set(this.normals);
      this.normals = normals;
      const uvs = new Float32Array(capacity * 2);
      uvs.set(this.uvs);
      this.uvs = uvs;
      const colors = new Float32Array(capacity * 3);
      colors.set(this.colors);
      this.colors = colors;
      const styles = new Float32Array(capacity * 4);
      styles.set(this.styles);
      this.styles = styles;
      const faces = new Float32Array(capacity * 4);
      faces.set(this.faces);
      this.faces = faces;
    }
    if (this.triangleCount + 2 > this.owners.length) {
      let capacity = this.owners.length;
      while (capacity < this.triangleCount + 2) capacity *= 2;
      const owners = new Uint32Array(capacity);
      owners.set(this.owners);
      this.owners = owners;
      const indices = new Uint32Array(capacity * 3);
      indices.set(this.indices);
      this.indices = indices;
    }
  }

  /** Write one vertex and return its index. Caller guarantees capacity. */
  private writeVertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    color: RGB,
    style: Vec4,
    face: Vec4,
  ): number {
    const index = this.vertexCount++;
    let p = index * 3;
    this.positions[p] = x;
    this.positions[p + 1] = y;
    this.positions[p + 2] = z;
    this.normals[p] = nx;
    this.normals[p + 1] = ny;
    this.normals[p + 2] = nz;
    let q = index * 2;
    this.uvs[q] = u;
    this.uvs[q + 1] = v;
    this.colors[p] = color[0];
    this.colors[p + 1] = color[1];
    this.colors[p + 2] = color[2];
    let r = index * 4;
    this.styles[r] = style[0];
    this.styles[r + 1] = style[1];
    this.styles[r + 2] = style[2];
    this.styles[r + 3] = style[3];
    this.faces[r] = face[0];
    this.faces[r + 1] = face[1];
    this.faces[r + 2] = face[2];
    this.faces[r + 3] = face[3];

    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
    return index;
  }

  /** Append one independent triangle with an explicit unit normal. */
  addTriangle(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    nx: number,
    ny: number,
    nz: number,
    ua: number,
    va: number,
    ub: number,
    vb: number,
    uc: number,
    vc: number,
    surface: SurfaceStyle,
  ): void {
    if (!(Number.isFinite(ax + ay + az + bx + by + bz + cx + cy + cz) && Number.isFinite(nx + ny + nz + ua + va + ub + vb + uc + vc))) {
      this.recordNonFinite([ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, ua, va, ub, vb, uc, vc], 1);
      return;
    }
    this.ensureVertices(3);
    const { color, style, face } = surface;
    const base = this.vertexCount;
    this.writeVertex(ax, ay, az, nx, ny, nz, ua, va, color, style, face);
    this.writeVertex(bx, by, bz, nx, ny, nz, ub, vb, color, style, face);
    this.writeVertex(cx, cy, cz, nx, ny, nz, uc, vc, color, style, face);
    const t = this.triangleCount * 3;
    this.indices[t] = base;
    this.indices[t + 1] = base + 1;
    this.indices[t + 2] = base + 2;
    this.owners[this.triangleCount] = surface.owner;
    this.triangleCount++;
  }

  /**
   * Append an axis-planar quad (a->b->c->d in perimeter order) with two
   * triangles from the same corner, oriented so the face normal matches
   * `nx,ny,nz`. Emits 4 shared vertices + 6 indices.
   */
  addQuad(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    ua: number,
    va: number,
    ub: number,
    vb: number,
    uc: number,
    vc: number,
    ud: number,
    vd: number,
    nx: number,
    ny: number,
    nz: number,
    surface: SurfaceStyle,
  ): void {
    const finitePositions = Number.isFinite(ax + ay + az + bx + by + bz + cx + cy + cz + dx + dy + dz);
    const finiteUvs = Number.isFinite(ua + va + ub + vb + uc + vc + ud + vd);
    if (!finitePositions || !finiteUvs || !Number.isFinite(nx + ny + nz)) {
      this.recordNonFinite(
        [
          ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz,
          ua, va, ub, vb, uc, vc, ud, vd, nx, ny, nz,
        ],
        2,
      );
      return;
    }
    // Cross products of (b-a)x(c-a) and (c-a)x(d-a), compared against the
    // desired normal. One of the two quad triangles can be degenerate (e.g.
    // gable end walls whose top edge meets the eave at a corner); such
    // triangles are dropped instead of emitted as zero-area slivers.
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const adx = dx - ax;
    const ady = dy - ay;
    const adz = dz - az;
    const cross1x = aby * acz - abz * acy;
    const cross1y = abz * acx - abx * acz;
    const cross1z = abx * acy - aby * acx;
    const cross2x = acy * adz - acz * ady;
    const cross2y = acz * adx - acx * adz;
    const cross2z = acx * ady - acy * adx;
    const cross1Sq = cross1x * cross1x + cross1y * cross1y + cross1z * cross1z;
    const cross2Sq = cross2x * cross2x + cross2y * cross2y + cross2z * cross2z;
    const DEGENERATE = 1e-8; // squared cross length => triangle area < 1e-4 m²
    const keep1 = cross1Sq > DEGENERATE;
    const keep2 = cross2Sq > DEGENERATE;
    if (!keep1 && !keep2) {
      this.recordNonFinite(
        [
          ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz,
          ua, va, ub, vb, uc, vc, ud, vd, nx, ny, nz,
        ],
        2,
      );
      return;
    }
    const useFirst = keep1 && (!keep2 || cross1Sq >= cross2Sq);
    const positive = useFirst
      ? cross1x * nx + cross1y * ny + cross1z * nz >= 0
      : cross2x * nx + cross2y * ny + cross2z * nz >= 0;

    this.ensureVertices(4);
    const { color, style, face } = surface;
    const v0 = this.vertexCount;
    this.writeVertex(ax, ay, az, nx, ny, nz, ua, va, color, style, face);
    if (positive) {
      this.writeVertex(bx, by, bz, nx, ny, nz, ub, vb, color, style, face);
      this.writeVertex(cx, cy, cz, nx, ny, nz, uc, vc, color, style, face);
      this.writeVertex(dx, dy, dz, nx, ny, nz, ud, vd, color, style, face);
    } else {
      // Reverse the quad winding while keeping per-corner UVs attached.
      this.writeVertex(dx, dy, dz, nx, ny, nz, ud, vd, color, style, face);
      this.writeVertex(cx, cy, cz, nx, ny, nz, uc, vc, color, style, face);
      this.writeVertex(bx, by, bz, nx, ny, nz, ub, vb, color, style, face);
    }
    let t = this.triangleCount * 3;
    if (keep1) {
      this.indices[t] = v0;
      this.indices[t + 1] = v0 + 1;
      this.indices[t + 2] = v0 + 2;
      this.owners[this.triangleCount] = surface.owner;
      this.triangleCount++;
      t += 3;
    }
    if (keep2) {
      this.indices[t] = v0;
      this.indices[t + 1] = v0 + 2;
      this.indices[t + 2] = v0 + 3;
      this.owners[this.triangleCount] = surface.owner;
      this.triangleCount++;
    }
  }

  /**
   * Build the merged BufferGeometry from zero-copy subarray views.
   *
   * A final quality pass drops degenerate / near-degenerate triangles: they
   * are invisible, but their float32 geometric normal is numerically noisy and
   * would break the explicit flat-normal contract. A triangle is kept only when
   * its area is at least 5e-5 * (longest edge)², which keeps the normal well
   * conditioned (≤ ~0.001 rad quantisation error).
   */
  finish(): MeshSinkResult {
    const vertexCount = this.vertexCount;
    const indices = this.indices;
    const owners = this.owners;
    const positions = this.positions;
    let triangleCount = this.triangleCount;
    let write = 0;
    const AREA_RATIO = 1e-4; // |cross| = 2*area must exceed ratio * longestEdge²
    // Positions are stored as float32; their quantisation error grows with the
    // absolute coordinate magnitude. Very thin triangles would get a noisy
    // geometric normal from those quantised positions, so require the area to
    // dominate the quantisation noise (see the comment above).
    const QUANTISATION_K = 250;
    const FLOAT32_REL_EPS = 1.1920929e-7;
    for (let read = 0; read < triangleCount; read++) {
      const i0 = indices[read * 3];
      const i1 = indices[read * 3 + 1];
      const i2 = indices[read * 3 + 2];
      const ax = positions[i0 * 3];
      const ay = positions[i0 * 3 + 1];
      const az = positions[i0 * 3 + 2];
      const bx = positions[i1 * 3];
      const by = positions[i1 * 3 + 1];
      const bz = positions[i1 * 3 + 2];
      const cx = positions[i2 * 3];
      const cy = positions[i2 * 3 + 1];
      const cz = positions[i2 * 3 + 2];
      const abx = bx - ax;
      const aby = by - ay;
      const abz = bz - az;
      const acx = cx - ax;
      const acy = cy - ay;
      const acz = cz - az;
      const crossX = aby * acz - abz * acy;
      const crossY = abz * acx - abx * acz;
      const crossZ = abx * acy - aby * acx;
      const crossSq = crossX * crossX + crossY * crossY + crossZ * crossZ;
      const bcx = cx - bx;
      const bcy = cy - by;
      const bcz = cz - bz;
      const longestSq = Math.max(
        abx * abx + aby * aby + abz * abz,
        acx * acx + acy * acy + acz * acz,
        bcx * bcx + bcy * bcy + bcz * bcz,
      );
      const limit = Math.max(
        AREA_RATIO * longestSq,
        2 * QUANTISATION_K * FLOAT32_REL_EPS * Math.max(Math.abs(ax), Math.abs(ay), Math.abs(az), Math.abs(bx), Math.abs(by), Math.abs(bz), Math.abs(cx), Math.abs(cy), Math.abs(cz)) * Math.sqrt(longestSq),
      );
      if (!(crossSq > limit * limit)) continue;
      if (write !== read) {
        indices[write * 3] = i0;
        indices[write * 3 + 1] = i1;
        indices[write * 3 + 2] = i2;
        owners[write] = owners[read];
      }
      write++;
    }
    triangleCount = write;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions.subarray(0, vertexCount * 3), 3),
    );
    geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals.subarray(0, vertexCount * 3), 3));
    geometry.setAttribute('aUV', new THREE.BufferAttribute(this.uvs.subarray(0, vertexCount * 2), 2));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors.subarray(0, vertexCount * 3), 3));
    geometry.setAttribute('aStyle', new THREE.BufferAttribute(this.styles.subarray(0, vertexCount * 4), 4));
    geometry.setAttribute('aFace', new THREE.BufferAttribute(this.faces.subarray(0, vertexCount * 4), 4));
    geometry.setIndex(new THREE.BufferAttribute(this.indices.subarray(0, triangleCount * 3), 1));

    if (triangleCount > 0) {
      const min = new THREE.Vector3(this.minX, this.minY, this.minZ);
      const max = new THREE.Vector3(this.maxX, this.maxY, this.maxZ);
      geometry.boundingBox = new THREE.Box3(min, max);
      const center = min.clone().add(max).multiplyScalar(0.5);
      const radius = center.distanceTo(max);
      geometry.boundingSphere = new THREE.Sphere(center, radius);
    } else {
      geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    }

    return {
      geometry,
      triangleOwner: this.owners.slice(0, triangleCount),
      triangleCount,
    };
  }
}

/** Re-exported for convenience so callers can build style payloads. */
export { FACE_KIND };
