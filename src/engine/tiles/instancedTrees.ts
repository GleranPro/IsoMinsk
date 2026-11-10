import * as THREE from 'three';
import { CANOPY_PALETTE, canopyColor, createCrownTemplate, createTrunkTemplate,
  type TreeInstances, type TreeInstanceBatch } from '../../city/environment/treeInstances';

export interface CanopyAppearance {
  palette: readonly string[];
  visible: boolean;
}

export interface TileTrees {
  trunks: THREE.InstancedMesh;
  crowns: THREE.InstancedMesh[];
  data: TreeInstances;
  dispose(): void;
}

/** Owned by one streamer. Tile eviction must never dispose these shared resources. */
export class TreeTemplateCache {
  private templates = new Map<string, THREE.BufferGeometry>();

  get(data: TreeInstances, template: number, trunk = false): THREE.BufferGeometry {
    const key = trunk ? 'trunk' : `${data.style}:${data.tier}:${template}`;
    let geometry = this.templates.get(key);
    if (!geometry) {
      geometry = trunk ? createTrunkTemplate() : createCrownTemplate(data.style, data.tier, template);
      this.templates.set(key, geometry);
    }
    return geometry;
  }

  get bytes(): number {
    let bytes = 0;
    for (const g of this.templates.values()) {
      for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
      bytes += g.index?.array.byteLength ?? 0;
    }
    return bytes;
  }

  dispose(): void {
    for (const geometry of this.templates.values()) geometry.dispose();
    this.templates.clear();
  }
}

export function createTileTrees(data: TreeInstances, cache: TreeTemplateCache,
  trunkMaterial: THREE.Material, canopyMaterial: THREE.Material, key: string,
  appearance: CanopyAppearance = { palette: CANOPY_PALETTE, visible: true }): TileTrees {
  const create = (batch: TreeInstanceBatch, trunk: boolean): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(cache.get(data, batch.template, trunk),
      trunk ? trunkMaterial : canopyMaterial, 0);
    // Adopt transferred storage directly instead of allocating and copying matrices.
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(batch.matrices, 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(batch.colors, 3);
    mesh.count = batch.count;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = `trees-${key}-${trunk ? 'trunks' : `crown-${batch.template}`}`;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    return mesh;
  };
  const trunks = create(data.trunks, true);
  const crowns = data.crowns.map(batch => create(batch, false));
  const result: TileTrees = { trunks, crowns, data,
    dispose() { trunks.dispose(); for (const mesh of crowns) mesh.dispose(); } };
  applyCanopyAppearance(result, appearance);
  return result;
}

/** Recolours existing GPU attributes; no geometry creation, fetch or worker job. */
export function applyCanopyAppearance(trees: TileTrees, appearance: CanopyAppearance): void {
  for (let b = 0; b < trees.crowns.length; b++) {
    const mesh = trees.crowns[b], batch = trees.data.crowns[b];
    mesh.visible = appearance.visible;
    for (let i = 0; i < batch.count; i++) canopyColor(batch.variations[i], appearance.palette).toArray(batch.colors, i * 3);
    mesh.instanceColor!.needsUpdate = true;
  }
}
