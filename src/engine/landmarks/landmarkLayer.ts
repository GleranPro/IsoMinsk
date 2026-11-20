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
  private loadPromise: Promise<void> | null = null;
  private highlight: THREE.Mesh | null = null;
  private highlightSlug: string | null = null;
  private readonly highlightMaterial: THREE.MeshBasicMaterial;
  private readonly baseHighlightOpacity = 0.55;

  constructor(options: LandmarkLayerOptions = {}) {
    this.options = options;
    this.root.name = 'landmark-models';
    this.highlightMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#e4b54a'),
      transparent: true,
      opacity: this.baseHighlightOpacity,
      depthWrite: false,
      depthTest: true,
      // Back faces only: the normal-offset copy is hidden behind the model
      // everywhere except the silhouette, so the landmark keeps its colours
      // and gets a thin gold outline instead of a full wash.
      side: THREE.BackSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.highlightMaterial.name = 'landmark-highlight';
  }

  async load(): Promise<void> {
    if (this.state === 'ready') return;
    // The layer is preloaded at startup; `?focus=` / `?info=` deep links call
    // load() again from markReady and must wait for that same request instead
    // of returning before the manifest exists.
    if (this.loadPromise) return this.loadPromise;
    this.state = 'loading';
    this.error = null;
    this.controller?.abort();
    this.controller = new AbortController();
    const promise = this.fetchAndBuild();
    this.loadPromise = promise;
    try {
      await promise;
    } finally {
      if (this.loadPromise === promise) this.loadPromise = null;
    }
  }

  private async fetchAndBuild(): Promise<void> {
    const baseUrl = this.options.baseUrl ?? LANDMARK_MODELS.dataUrl;
    try {
      const [manifestResponse, binaryResponse] = await Promise.all([
        fetch(`${baseUrl}/manifest.json`, {
          cache: 'no-cache',
          signal: this.controller!.signal,
        }),
        fetch(`${baseUrl}/landmarks.bin`, { cache: 'no-cache', signal: this.controller!.signal }),
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
      mesh.userData.slug = meta.slug;
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

  /** Meshes for the scene raycaster (empty until the payload is loaded). */
  getPickables(): THREE.Mesh[] {
    return [...this.meshes.values()];
  }

  getMeta(slug: string): LandmarkMeta | null {
    return this.manifest?.landmarks.find((entry) => entry.slug === slug) ?? null;
  }

  /**
   * Anchor-relative geometry of one landmark, centred horizontally and dropped
   * onto y=0 for the card's preview viewer (null before the payload loads).
   */
  getPreview(slug: string): { positions: Float32Array; colors: Float32Array } | null {
    const mesh = this.meshes.get(slug);
    if (!mesh) return null;
    const position = mesh.geometry.getAttribute('position');
    const color = mesh.geometry.getAttribute('color');
    if (!position || !color) return null;

    const positions = new Float32Array(position.array as Float32Array);
    const colors = new Float32Array(color.array as Float32Array);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    for (let i = 0; i < position.count; i += 1) {
      positions[i * 3] -= cx;
      positions[i * 3 + 1] -= minY;
      positions[i * 3 + 2] -= cz;
    }
    return { positions, colors };
  }

  /** Currently highlighted landmark slug (null when nothing is selected). */
  get selectedSlug(): string | null {
    return this.highlightSlug;
  }

  /**
   * Gold overlay for the picked landmark. The overlay is the same geometry
   * pushed slightly along its normals, matching the building highlight look
   * without touching the shared landmark material.
   */
  setSelected(slug: string | null): void {
    if (this.highlightSlug === slug) return;
    this.clearHighlight();
    this.highlightSlug = slug;
    if (!slug) return;
    const mesh = this.meshes.get(slug);
    if (!mesh) {
      this.highlightSlug = null;
      return;
    }
    const source = mesh.geometry.getAttribute('position');
    const normals = mesh.geometry.getAttribute('normal');
    if (!source || !normals) {
      this.highlightSlug = null;
      return;
    }
    const positions = new Float32Array(source.count * 3);
    for (let i = 0; i < source.count; i += 1) {
      positions[i * 3] = source.getX(i) + normals.getX(i) * 0.5;
      positions[i * 3 + 1] = source.getY(i) + normals.getY(i) * 0.5;
      positions[i * 3 + 2] = source.getZ(i) + normals.getZ(i) * 0.5;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const overlay = new THREE.Mesh(geometry, this.highlightMaterial);
    overlay.name = `landmark-highlight-${slug}`;
    overlay.position.copy(mesh.position);
    overlay.renderOrder = 6;
    overlay.matrixAutoUpdate = false;
    overlay.updateMatrix();
    this.highlight = overlay;
    this.root.add(overlay);
  }

  /** Gentle pulse so the selected model reads without being garish. */
  update(timeMs: number): void {
    if (!this.highlight) return;
    const pulse = 0.82 + 0.18 * Math.sin(timeMs * 0.004);
    this.highlightMaterial.opacity = this.baseHighlightOpacity * pulse;
  }

  private clearHighlight(): void {
    if (!this.highlight) return;
    this.root.remove(this.highlight);
    this.highlight.geometry.dispose();
    this.highlight = null;
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
    this.clearHighlight();
    this.highlightSlug = null;
    for (const mesh of this.meshes.values()) {
      this.root.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();
    this.material.dispose();
    this.highlightMaterial.dispose();
    this.root.removeFromParent();
    this.root.clear();
    this.state = 'idle';
    this.manifest = null;
  }
}
