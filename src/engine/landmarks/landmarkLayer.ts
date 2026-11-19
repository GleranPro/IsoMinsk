/**
 * Low-poly landmark models — scene layer.
 *
 * Payload (`public/data/landmarks`, baked by scripts/landmarks/bake_landmarks.py):
 *   manifest.json   — per-landmark anchor (local metres), yaw/scale, vertex range
 *   landmarks.bin   — int16 east/height/north (decimetres, relative to the
 *                     landmark anchor) + uint8 RGB per vertex, non-indexed
 *
 * One mesh per landmark, positioned at its anchor, so frustum culling works per
 * building and the far ones (Minsk-Arena, National Library) cost nothing when
 * off screen. Same flat-shaded Lambert look as the museum exhibits. World
 * convention matches the engine: x east, y up, -y north.
 */

import * as THREE from 'three';
import { LANDMARK_MODELS } from '../../shared/landmarks';

export interface LandmarkMeta {
  slug: string;
  label: string;
  osm: string;
  x: number;
  y: number;
  yaw: number;
  scale: number;
  hide: string[];
  start: number;
  count: number;
  triangles: number;
  extent: [number, number, number, number];
  heightM: number;
}

export interface LandmarkManifest {
  version: number;
  positionScale: number;
  vertices: number;
  triangles: number;
  byteLength: number;
  landmarks: LandmarkMeta[];
}

export type LandmarkLayerState = 'idle' | 'loading' | 'ready' | 'error';

export interface LandmarkLayerOptions {
  baseUrl?: string;
  onReady?: () => void;
  onError?: (message: string) => void;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function createLandmarkMaterial(): THREE.Material {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    fog: true,
    emissive: new THREE.Color().setRGB(0.02, 0.022, 0.027),
  });
  material.name = 'IsometricMinskLandmarks';
  return material;
}

/**
 * Decode one landmark's slice of the shared buffer into a geometry (anchor
 * relative, metres). Exported for the unit tests: no WebGL context needed.
 */
export function createLandmarkGeometry(
  manifest: Pick<LandmarkManifest, 'vertices' | 'positionScale'>,
  meta: Pick<LandmarkMeta, 'start' | 'count'>,
  buffer: ArrayBuffer,
): THREE.BufferGeometry {
  const total = manifest.vertices;
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`landmark manifest has invalid vertex count: ${manifest.vertices}`);
  }
  if (buffer.byteLength < total * 9) {
    throw new Error(`landmarks.bin is ${buffer.byteLength} B, expected >= ${total * 9} B`);
  }
  if (meta.start < 0 || meta.count <= 0 || meta.start + meta.count > total || meta.count % 3 !== 0) {
    throw new Error(`landmark range ${meta.start}+${meta.count} is outside ${total} vertices`);
  }
  const scale = 1 / Math.max(manifest.positionScale, 1e-6);
  const east = new Int16Array(buffer, 0, total);
  const height = new Int16Array(buffer, total * 2, total);
  const north = new Int16Array(buffer, total * 4, total);
  const rgb = new Uint8Array(buffer, total * 6, total * 3);

  const positions = new Float32Array(meta.count * 3);
  const colors = new Float32Array(meta.count * 3);
  for (let i = 0; i < meta.count; i += 1) {
    const src = meta.start + i;
    positions[i * 3] = east[src] * scale;
    positions[i * 3 + 1] = height[src] * scale;
    positions[i * 3 + 2] = -north[src] * scale;
    colors[i * 3] = srgbToLinear(rgb[src * 3] / 255);
    colors[i * 3 + 1] = srgbToLinear(rgb[src * 3 + 1] / 255);
    colors[i * 3 + 2] = srgbToLinear(rgb[src * 3 + 2] / 255);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

export class LandmarkLayer {
  readonly root = new THREE.Group();
  state: LandmarkLayerState = 'idle';
  manifest: LandmarkManifest | null = null;
  error: string | null = null;

  private readonly options: LandmarkLayerOptions;
  private readonly material = createLandmarkMaterial();
  private readonly meshes = new Map<string, THREE.Mesh>();
  private controller: AbortController | null = null;

  constructor(options: LandmarkLayerOptions = {}) {
    this.options = options;
    this.root.name = 'landmark-models';
  }

  async load(): Promise<void> {
    if (this.state === 'loading' || this.state === 'ready') return;
    this.state = 'loading';
    this.error = null;
    this.controller?.abort();
    this.controller = new AbortController();
    const baseUrl = this.options.baseUrl ?? LANDMARK_MODELS.dataUrl;
    try {
      const [manifestResponse, binaryResponse] = await Promise.all([
        fetch(`${baseUrl}/manifest.json`, { cache: 'no-cache', signal: this.controller.signal }),
        fetch(`${baseUrl}/landmarks.bin`, { cache: 'no-cache', signal: this.controller.signal }),
      ]);
      if (!manifestResponse.ok) throw new Error(`manifest HTTP ${manifestResponse.status}`);
      if (!binaryResponse.ok) throw new Error(`landmarks HTTP ${binaryResponse.status}`);
      const manifest = (await manifestResponse.json()) as LandmarkManifest;
      const buffer = await binaryResponse.arrayBuffer();
      this.build(manifest, buffer);
      this.state = 'ready';
      this.options.onReady?.();
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.state = 'error';
      this.error = error instanceof Error ? error.message : String(error);
      this.options.onError?.(`landmark layer: ${this.error}`);
    }
  }

  private build(manifest: LandmarkManifest, buffer: ArrayBuffer): void {
    for (const meta of manifest.landmarks) {
      const mesh = new THREE.Mesh(createLandmarkGeometry(manifest, meta, buffer), this.material);
      mesh.name = `landmark-${meta.slug}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(meta.x, 0, -meta.y);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      this.meshes.set(meta.slug, mesh);
    }
    this.manifest = manifest;
    this.root.updateMatrixWorld(true);
  }

  getMesh(slug: string): THREE.Mesh | null {
    return this.meshes.get(slug) ?? null;
  }

  getTriangles(): number {
    return this.state === 'ready' ? (this.manifest?.triangles ?? 0) : 0;
  }

  /** Local-metre centre of a landmark's footprint (for camera focus). */
  focusPoint(slug: string): { x: number; y: number } | null {
    const meta = this.manifest?.landmarks.find((entry) => entry.slug === slug);
    if (!meta) return null;
    const [minE, minN, maxE, maxN] = meta.extent;
    return { x: meta.x + (minE + maxE) / 2, y: meta.y + (minN + maxN) / 2 };
  }

  dispose(): void {
    this.controller?.abort();
    this.controller = null;
    for (const mesh of this.meshes.values()) {
      this.root.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();
    this.material.dispose();
    this.root.removeFromParent();
    this.root.clear();
    this.state = 'idle';
    this.manifest = null;
  }
}
