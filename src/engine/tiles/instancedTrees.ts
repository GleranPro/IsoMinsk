import * as THREE from 'three';
import { CANOPY_PALETTE, canopyColor, createCrownTemplate, createTrunkTemplate,
  createWinterCrownTemplate, type TreeInstances, type TreeInstanceBatch } from '../../city/environment/treeInstances';

export interface CanopyAppearance {
  /** Broadleaf baseline palette (summer green in autumn). */
  palette: readonly string[];
  /** Broadleaf autumn target; blended per tree by `autumnMix` and variation. */
  autumnPalette?: readonly string[];
  /** Green palette for conifers, which never turn. */
  coniferPalette?: readonly string[];
  /** 0 = all broadleaf still green, 1 = late autumn. */
  autumnMix?: number;
  visible: boolean;
  /** Winter mode: broadleaf crowns swap to bare branches. */
  winter?: boolean;
}

export interface TileTrees {
  trunks: THREE.InstancedMesh;
  crowns: THREE.InstancedMesh[];
  /** Bare branches for broadleaf batches; share the summer instance matrices. */
  winterCrowns: THREE.InstancedMesh[];
  data: TreeInstances;
  dispose(): void;
}

/** Owned by one streamer. Tile eviction must never dispose these shared resources. */
export class TreeTemplateCache {
  private templates = new Map<string, THREE.BufferGeometry>();

  get(data: TreeInstances, template: number, trunk = false, winter = false): THREE.BufferGeometry {
    const key = trunk
      ? 'trunk'
      : `${winter ? 'winter' : 'summer'}:${data.style}:${data.tier}:${template}`;
    let geometry = this.templates.get(key);
    if (!geometry) {
      geometry = trunk
        ? createTrunkTemplate()
        : winter
          ? createWinterCrownTemplate(data.style, data.tier, template)
          : createCrownTemplate(data.style, data.tier, template);
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
  appearance: CanopyAppearance = { palette: CANOPY_PALETTE, visible: true, winter: false }): TileTrees {
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
    mesh.name = `trees-${key}-${trunk ? 'trunks' : `crown-${batch.species}-${batch.template}`}`;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    return mesh;
  };
  // Bare branches reuse the summer instance matrices (one shared attribute, no
  // second GPU upload) and keep their colour in the template geometry.
  const createWinter = (batch: TreeInstanceBatch): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(
      cache.get(data, batch.template, false, true),
      canopyMaterial,
      0,
    );
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(batch.matrices, 16);
    mesh.count = batch.count;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.name = `trees-${key}-winter-${batch.template}`;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    return mesh;
  };
  const trunks = create(data.trunks, true);
  const crowns = data.crowns.map(batch => create(batch, false));
  const winterCrowns = data.crowns
    .filter(batch => batch.species === 0)
    .map(createWinter);
  const result: TileTrees = { trunks, crowns, winterCrowns, data,
    dispose() { trunks.dispose(); for (const mesh of crowns) mesh.dispose(); for (const mesh of winterCrowns) mesh.dispose(); } };
  applyCanopyAppearance(result, appearance);
  return result;
}

/** Recolours existing GPU attributes; no geometry creation, fetch or worker job. */
export function applyCanopyAppearance(trees: TileTrees, appearance: CanopyAppearance): void {
  const winter = appearance.winter === true;
  const autumnMix = Math.min(1, Math.max(0, appearance.autumnMix ?? 0));
  const autumnPalette = appearance.autumnPalette ?? appearance.palette;
  const coniferPalette = appearance.coniferPalette
    ?? (winter ? CANOPY_PALETTE : appearance.palette);
  for (let b = 0; b < trees.crowns.length; b++) {
    const mesh = trees.crowns[b], batch = trees.data.crowns[b];
    // Broadleaf crowns disappear in winter; conifers stay green under snow.
    mesh.visible = appearance.visible && !(winter && batch.species === 0);
    for (let i = 0; i < batch.count; i++) {
      const variation = batch.variations[i];
      if (batch.species === 1) {
        // Conifers never turn: green through autumn and winter.
        canopyColor(variation, coniferPalette).toArray(batch.colors, i * 3);
        continue;
      }
      const summer = canopyColor(variation, appearance.palette);
      const autumn = canopyColor(variation, autumnPalette);
      // Different trees turn at different times: a high variation lags behind.
      const phase = Math.min(1, Math.max(0, autumnMix * 1.35 - variation * 0.35));
      summer.lerp(autumn, phase).toArray(batch.colors, i * 3);
    }
    mesh.instanceColor!.needsUpdate = true;
  }
  for (const mesh of trees.winterCrowns) mesh.visible = appearance.visible && winter;
}
