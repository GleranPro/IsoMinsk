/**
 * Lipki aviation museum — scene layer.
 *
 * The exhibit models are exported offline by `scripts/qa/export_museum_web.py`
 * into `public/data/museum/`:
 *   manifest.json  — origin, per-exhibit vertex ranges, bounds
 *   exhibits.bin   — int16 east/height/north (decimetres) + uint8 RGB, per vertex
 *
 * The layer fetches both once, uploads one non-indexed BufferGeometry (the bake
 * duplicates vertices per triangle corner, so flat shading comes for free) and
 * places it at the museum origin. World convention matches the rest of the
 * engine: x east, y up, -y north (see buildingsMesh header).
 */

import * as THREE from 'three';
import { publicAssetUrl } from '../../shared/assets';

export interface MuseumExhibitMeta {
  slug: string;
  ref: string;
  x: number;
  y: number;
  heading: number;
  start: number;
  count: number;
  triangles: number;
  axisSource: string;
  lengthM: number;
  spanM: number;
}

export interface MuseumManifest {
  version: number;
  origin: [number, number];
  positionScale: number;
  vertices: number;
  triangles: number;
  byteLength: number;
  sections: { name: string; type: string; count: number; offset: number }[];
  exhibits: MuseumExhibitMeta[];
  missing: { label: string; x: number; y: number; heading: number }[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export type MuseumState = 'idle' | 'loading' | 'ready' | 'error';

export interface MuseumLayerOptions {
  /** Base URL of the exported payload (default `data/museum` below the deployment base). */
  baseUrl?: string;
  /** Called once the exhibits are in the scene (refresh shadows etc.). */
  onReady?: () => void;
  /** Called on fetch/parse failures (the map itself keeps working). */
  onError?: (message: string) => void;
  /** Optional shared material; otherwise the layer owns a Lambert material. */
  material?: THREE.Material;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function createMuseumMaterial(): THREE.Material {
  // Same stylised lighting as the environment surfaces: flat-shaded Lambert
  // with a tiny additive floor so exhibits stay readable in shadow.
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    fog: true,
    emissive: new THREE.Color().setRGB(0.02, 0.022, 0.027),
  });
  material.name = 'IsometricMinskMuseum';
  return material;
}

/**
 * Decode the exported payload into a renderable geometry.
 *
 * Layout (little-endian): int16 east/height/north in decimetres for every
 * vertex, then uint8 RGB. The bake duplicates vertices per triangle corner, so
 * the geometry is non-indexed and `computeVertexNormals` yields flat facets.
 * Exported separately so unit tests can exercise the binary contract without a
 * WebGL context.
 */
export function createMuseumGeometry(manifest: MuseumManifest, buffer: ArrayBuffer): THREE.BufferGeometry {
  const vertices = manifest.vertices;
  const scale = 1 / Math.max(manifest.positionScale, 1e-6);
  if (!Number.isFinite(vertices) || vertices <= 0) {
    throw new Error(`museum manifest has invalid vertex count: ${manifest.vertices}`);
  }
  if (buffer.byteLength < vertices * 9) {
    throw new Error(`exhibits.bin is ${buffer.byteLength} B, expected >= ${vertices * 9} B`);
  }
  const xs = new Int16Array(buffer, 0, vertices);
  const zs = new Int16Array(buffer, vertices * 2, vertices);
  const ys = new Int16Array(buffer, vertices * 4, vertices);
  const rgb = new Uint8Array(buffer, vertices * 6, vertices * 3);

  const positions = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  for (let index = 0; index < vertices; index += 1) {
    positions[index * 3] = xs[index] * scale;
    positions[index * 3 + 1] = zs[index] * scale;
    positions[index * 3 + 2] = -ys[index] * scale;
    colors[index * 3] = srgbToLinear(rgb[index * 3] / 255);
    colors[index * 3 + 1] = srgbToLinear(rgb[index * 3 + 1] / 255);
    colors[index * 3 + 2] = srgbToLinear(rgb[index * 3 + 2] / 255);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

export class MuseumLayer {
  readonly root = new THREE.Group();
  state: MuseumState = 'idle';
  manifest: MuseumManifest | null = null;
  triangles = 0;
  error: string | null = null;

  private readonly options: MuseumLayerOptions;
  private readonly material: THREE.Material;
  private readonly ownsMaterial: boolean;
  private geometry: THREE.BufferGeometry | null = null;
  private mesh: THREE.Mesh | null = null;
  private controller: AbortController | null = null;

  constructor(options: MuseumLayerOptions = {}) {
    this.options = options;
    this.root.name = 'museum';
    this.root.visible = false;
    this.root.matrixAutoUpdate = false;
    if (options.material) {
      this.material = options.material;
      this.ownsMaterial = false;
    } else {
      this.material = createMuseumMaterial();
      this.ownsMaterial = true;
    }
  }

  /** Fetch and add the exhibits. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.state === 'loading' || this.state === 'ready') return;
    this.state = 'loading';
    this.error = null;
    this.controller?.abort();
    this.controller = new AbortController();
    const baseUrl = this.options.baseUrl ?? publicAssetUrl('data/museum');
    try {
      const [manifestResponse, binaryResponse] = await Promise.all([
        fetch(`${baseUrl}/manifest.json`, { cache: 'no-cache', signal: this.controller.signal }),
        fetch(`${baseUrl}/exhibits.bin`, { cache: 'no-cache', signal: this.controller.signal }),
      ]);
      if (!manifestResponse.ok) throw new Error(`manifest HTTP ${manifestResponse.status}`);
      if (!binaryResponse.ok) throw new Error(`exhibits HTTP ${binaryResponse.status}`);
      const manifest = (await manifestResponse.json()) as MuseumManifest;
      const buffer = await binaryResponse.arrayBuffer();
      this.build(manifest, buffer);
      this.state = 'ready';
      this.options.onReady?.();
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.state = 'error';
      this.error = error instanceof Error ? error.message : String(error);
      this.options.onError?.(`museum layer: ${this.error}`);
    }
  }

  private build(manifest: MuseumManifest, buffer: ArrayBuffer): void {
    const geometry = createMuseumGeometry(manifest, buffer);

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'museum-exhibits';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.root.add(mesh);
    this.root.position.set(manifest.origin[0], 0, -manifest.origin[1]);
    this.root.updateMatrix();
    this.root.visible = true;
    this.root.updateMatrixWorld(true);

    this.geometry = geometry;
    this.mesh = mesh;
    this.manifest = manifest;
    this.triangles = manifest.triangles;
    // Triangle -> exhibit index, so a raycast hit can open the right card.
    const owner = new Uint32Array(manifest.triangles);
    manifest.exhibits.forEach((exhibit, index) => {
      const first = Math.round(exhibit.start / 3);
      const end = Math.min(manifest.triangles, Math.round((exhibit.start + exhibit.count) / 3));
      owner.fill(index, first, end);
    });
    this.triangleOwner = owner;
  }

  /** Triangle -> exhibit index (empty until ready). */
  triangleOwner = new Uint32Array(0);

  /** Exhibit index for a triangle hit (-1 outside the range). */
  exhibitIndexForTriangle(triangleIndex: number): number {
    if (triangleIndex < 0 || triangleIndex >= this.triangleOwner.length) return -1;
    return this.triangleOwner[triangleIndex];
  }

  /** Exhibit metadata for a triangle hit (null when outside the range). */
  exhibitForTriangle(triangleIndex: number): MuseumExhibitMeta | null {
    if (triangleIndex < 0 || triangleIndex >= this.triangleOwner.length) return null;
    const index = this.triangleOwner[triangleIndex];
    return this.manifest?.exhibits[index] ?? null;
  }

  /** Display index of an exhibit slug (first match), or -1. */
  indexOfSlug(slug: string): number {
    if (!this.manifest) return -1;
    return this.manifest.exhibits.findIndex((exhibit) => exhibit.slug === slug);
  }

  /**
   * Local-space geometry of one exhibit, centred and normalised for the card's
   * preview viewer. Returns null before the payload is loaded.
   */
  getExhibitPreview(index: number): {
    positions: Float32Array;
    colors: Float32Array;
    lengthM: number;
    spanM: number;
  } | null {
    if (!this.manifest || !this.geometry) return null;
    const exhibit = this.manifest.exhibits[index];
    if (!exhibit) return null;
    const attributes = this.geometry.getAttribute('position');
    const colors = this.geometry.getAttribute('color');
    if (!attributes || !colors) return null;
    const start = exhibit.start;
    const count = exhibit.count;
    const positions = new Float32Array(count * 3);
    const outColors = new Float32Array(count * 3);
    const step = 1 / Math.max(this.manifest.positionScale, 1e-6);
    void step;
    const src = attributes.array as Float32Array;
    const srcColors = colors.array as Float32Array;
    positions.set(src.subarray(start * 3, (start + count) * 3));
    outColors.set(srcColors.subarray(start * 3, (start + count) * 3));

    // Centre horizontally and drop the model onto y=0 for the preview.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = minZ;
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] -= cx;
      positions[i * 3 + 1] -= cy;
      positions[i * 3 + 2] -= cz;
    }
    return {
      positions,
      colors: outColors,
      lengthM: exhibit.lengthM,
      spanM: exhibit.spanM,
    };
  }

  /** Triangles currently in the scene (0 until ready). */
  getTriangles(): number {
    return this.state === 'ready' ? this.triangles : 0;
  }

  /** World-space bounds of the exhibits (for cameras/tests). */
  getWorldBounds(target = new THREE.Box3()): THREE.Box3 {
    target.makeEmpty();
    if (this.geometry === null) return target;
    if (!this.geometry.boundingBox) this.geometry.computeBoundingBox();
    target.copy(this.geometry.boundingBox as THREE.Box3);
    target.applyMatrix4(this.root.matrixWorld);
    return target;
  }

  getMesh(): THREE.Mesh | null {
    return this.mesh;
  }

  dispose(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.mesh) {
      this.root.remove(this.mesh);
      this.mesh = null;
    }
    this.geometry?.dispose();
    this.geometry = null;
    if (this.ownsMaterial) this.material.dispose();
    this.root.removeFromParent();
    this.root.clear();
    this.state = 'idle';
    this.triangles = 0;
    this.triangleOwner = new Uint32Array(0);
    this.manifest = null;
  }
}
