/**
 * Environment materials (ground, roads, water, trees).
 *
 * The real material lives in the facade/art-direction module so that all
 * surfaces share one stylised lighting model. This wrapper prefers that
 * implementation and falls back to a plain vertex-coloured Lambert material so
 * the renderer always boots, even while the material module is being replaced.
 *
 * Environment geometry is merged per tile by the tile builder into a single
 * non-indexed geometry with `position`, `normal` and `color` (sRGB-encoded
 * vertex colours linearised by the material).
 */

import * as THREE from 'three';
import * as facadeModuleNamespace from './facadeMaterial';

type UnknownRecord = Record<string, unknown>;

const moduleRecord = facadeModuleNamespace as unknown as UnknownRecord;

export interface EnvironmentMaterialSet {
  /** Shared material for ground + roads + water. */
  environment: THREE.Material;
  /** Shared material for trees (separate shadow-casting mesh). */
  trees: THREE.Material;
  treeTrunks: THREE.Material;
  treeCanopies: THREE.Material;
  attractions: THREE.Material;
  dispose(): void;
}

function createFallbackMaterial(name: string): THREE.Material {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
  });
  material.name = name;
  return material;
}

function tryCreateModuleMaterial(name: string): THREE.Material | null {
  const factory = moduleRecord.createEnvironmentMaterial;
  if (typeof factory !== 'function') return null;
  try {
    const material = (factory as () => unknown)() as THREE.Material | undefined;
    if (material && (material as THREE.Material).isMaterial) {
      material.name = material.name || name;
      return material;
    }
  } catch (error) {
    console.warn('[renderer] createEnvironmentMaterial threw; using Lambert fallback', error);
  }
  return null;
}

export function createEnvironmentMaterialSet(): EnvironmentMaterialSet {
  const environment = tryCreateModuleMaterial('environment') ?? createFallbackMaterial('environment');
  const trees = tryCreateModuleMaterial('trees') ?? createFallbackMaterial('trees');
  const treeTrunks = tryCreateModuleMaterial('tree-trunks') ?? createFallbackMaterial('tree-trunks');
  const treeCanopies = tryCreateModuleMaterial('tree-canopies') ?? createFallbackMaterial('tree-canopies');
  const attractions = tryCreateModuleMaterial('attractions') ?? createFallbackMaterial('attractions');
  return {
    environment,
    trees,
    treeTrunks,
    treeCanopies,
    attractions,
    dispose() {
      environment.dispose();
      if (trees !== environment) trees.dispose();
      treeTrunks.dispose();
      treeCanopies.dispose();
      attractions.dispose();
    },
  };
}

/** Wireframe debug switch shared by all environment surfaces. */
export function setEnvironmentWireframe(set: EnvironmentMaterialSet, enabled: boolean): void {
  const wireframe = Boolean(enabled);
  for (const material of [set.environment, set.trees, set.treeTrunks, set.treeCanopies, set.attractions]) {
    const lambert = material as THREE.MeshLambertMaterial;
    if ('wireframe' in lambert) lambert.wireframe = wireframe;
    material.needsUpdate = true;
  }
}
