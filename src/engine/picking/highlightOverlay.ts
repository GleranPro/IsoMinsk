/**
 * Selected-building highlight.
 *
 * Merged tile geometry cannot be highlighted by toggling per-object state, so
 * the selected building's triangles are extracted into a small overlay mesh
 * (slightly offset along their normals to avoid z-fighting). The overlay is
 * rebuilt when the selection changes and survives tile (re)loads because
 * createCityApp re-applies the highlight after tile changes.
 */

import * as THREE from 'three';
import type { FeatureId } from '../../shared/types';

export interface HighlightSource {
  id: FeatureId;
  geometry: THREE.BufferGeometry;
  triangleOwner: Uint32Array | null;
  buildingIds: FeatureId[];
}

const HIGHLIGHT_COLOR = '#ffd06a';
const NORMAL_OFFSET_M = 0.14;

export class BuildingHighlighter {
  private readonly root: THREE.Group;
  private readonly material: THREE.MeshBasicMaterial;
  private mesh: THREE.Mesh | null = null;
  private sourceId: FeatureId | null = null;
  private readonly baseOpacity = 0.42;
  private readonly time = { value: 0 };

  constructor(root: THREE.Group) {
    this.root = root;
    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(HIGHLIGHT_COLOR),
      transparent: true,
      opacity: this.baseOpacity,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.material.name = 'building-highlight';
  }

  get highlightedId(): FeatureId | null {
    return this.sourceId;
  }

  /** Rebuild the overlay for the given building (null clears it). */
  setHighlight(source: HighlightSource | null): void {
    this.clearMesh();
    this.sourceId = source ? source.id : null;
    if (!source) return;
    const geometry = buildOverlayGeometry(source);
    if (!geometry) {
      this.sourceId = null;
      return;
    }
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'building-highlight-overlay';
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.mesh = mesh;
    this.root.add(mesh);
  }

  /** Gentle pulse so the selection reads without being garish. */
  update(timeMs: number): void {
    if (!this.mesh) return;
    this.time.value = timeMs;
    const pulse = 0.82 + 0.18 * Math.sin(timeMs * 0.004);
    this.material.opacity = this.baseOpacity * pulse;
  }

  dispose(): void {
    this.clearMesh();
    this.material.dispose();
    void this.root;
  }

  private clearMesh(): void {
    if (!this.mesh) return;
    this.root.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
  }
}

function readComponent(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
  component: number,
): number {
  const anyAttribute = attribute as unknown as {
    getComponent?: (i: number, c: number) => number;
    getX?: (i: number) => number;
    getY?: (i: number) => number;
    getZ?: (i: number) => number;
    array?: ArrayLike<number>;
    itemSize?: number;
    isInterleavedBufferAttribute?: boolean;
  };
  if (typeof anyAttribute.getComponent === 'function') {
    return anyAttribute.getComponent(index, component);
  }
  if (!anyAttribute.isInterleavedBufferAttribute && anyAttribute.array) {
    const stride = anyAttribute.itemSize ?? attribute.itemSize;
    return anyAttribute.array[index * stride + component] ?? 0;
  }
  if (component === 0) return anyAttribute.getX?.(index) ?? 0;
  if (component === 1) return anyAttribute.getY?.(index) ?? 0;
  return anyAttribute.getZ?.(index) ?? 0;
}

/** Extract the triangles belonging to one building into a small geometry. */
function buildOverlayGeometry(source: HighlightSource): THREE.BufferGeometry | null {
  const geometry = source.geometry;
  const position = geometry.getAttribute('position');
  if (!position || !source.triangleOwner) return null;
  const ownerIndex = source.buildingIds.indexOf(source.id);
  if (ownerIndex < 0) return null;
  const owners = source.triangleOwner;
  const triangleCount = owners.length;
  const normalAttribute = geometry.getAttribute('normal');
  const indexAttribute = geometry.getIndex();

  const positions: number[] = [];
  const normals: number[] = [];
  const vertexCount = Math.min(triangleCount * 3, owners.length * 3);

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    if (owners[triangleIndex] !== ownerIndex) continue;
    for (let corner = 0; corner < 3; corner += 1) {
      const rawIndex = indexAttribute
        ? readComponent(indexAttribute, triangleIndex * 3 + corner, 0)
        : triangleIndex * 3 + corner;
      const vertexIndex = Math.floor(rawIndex);
      if (vertexIndex < 0 || vertexIndex >= position.count) continue;
      const px = readComponent(position, vertexIndex, 0);
      const py = readComponent(position, vertexIndex, 1);
      const pz = readComponent(position, vertexIndex, 2);
      let nx = 0;
      let ny = 1;
      let nz = 0;
      if (normalAttribute) {
        nx = readComponent(normalAttribute, vertexIndex, 0);
        ny = readComponent(normalAttribute, vertexIndex, 1);
        nz = readComponent(normalAttribute, vertexIndex, 2);
      }
      positions.push(
        px + nx * NORMAL_OFFSET_M,
        py + ny * NORMAL_OFFSET_M,
        pz + nz * NORMAL_OFFSET_M,
      );
      normals.push(nx, ny, nz);
    }
  }
  void vertexCount;

  if (positions.length === 0) return null;
  const overlay = new THREE.BufferGeometry();
  overlay.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  overlay.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  overlay.computeBoundingSphere();
  return overlay;
}
