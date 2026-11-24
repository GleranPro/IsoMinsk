/**
 * Facade material bridge.
 *
 * The procedural facade shader is owned by the facades/art-direction module
 * (src/engine/materials/facadeMaterial.ts). Its public surface may be built up
 * incrementally while the project is in flight, so this bridge is deliberately
 * defensive: every access goes through a guarded namespace lookup and a local
 * Lambert fallback keeps the city rendering if the material module is stubbed,
 * stale or throws during construction.
 *
 * Do not move facade shader code here: this file only adapts it to the engine.
 */

import * as THREE from 'three';
import * as facadeModuleNamespace from '../materials/facadeMaterial';
import type { CloudShadeUniforms } from './cloudShade';
import type { SeasonUniforms } from './seasonUniforms';

export interface FacadeMaterialOptionsLike {
  detail: boolean;
  night: number;
  quantise?: boolean;
}

export interface FacadeUniformPatch {
  night?: number;
  detailScale?: number;
  pixelSize?: number;
  paletteMix?: number;
  timeHours?: number;
}

type UnknownRecord = Record<string, unknown>;

const moduleRecord = facadeModuleNamespace as unknown as UnknownRecord;

function getFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const value = moduleRecord[name];
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : null;
}

function warnOnce(message: string, error: unknown): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  // Warnings only: the e2e suite treats console.error as a failure, and a
  // missing optional facade helper must never be fatal.
  console.warn(`[renderer] ${message}`, error);
}

const warnedMessages = new Set<string>();

/** Create the facade material, falling back to vertex-coloured Lambert. */
export function createFacadeMaterialSafe(options: FacadeMaterialOptionsLike): THREE.Material {
  const create = getFunction('createFacadeMaterial');
  if (create) {
    try {
      const material = create(options) as THREE.Material | undefined;
      if (material && (material as THREE.Material).isMaterial) {
        material.name = material.name || 'facade';
        return material;
      }
    } catch (error) {
      warnOnce('createFacadeMaterial threw; using Lambert fallback', error);
    }
  }
  return new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
}

/**
 * Wire the shared cloud-shade uniforms into a facade material (module helper
 * when present; a no-op keeps the fallback material rendering if the module is
 * stubbed). Must run before the material's first compile.
 */
export function applyCloudShadeSafe(
  material: THREE.Material | null | undefined,
  uniforms: CloudShadeUniforms,
): void {
  if (!material) return;
  const apply = getFunction('applyFacadeCloudShade');
  if (apply) {
    try {
      apply(material, uniforms);
      return;
    } catch (error) {
      warnOnce('applyFacadeCloudShade threw; facades keep unshaded albedo', error);
    }
  }
}

/**
 * Share the season uniforms (snow on roofs/trim) with a facade material.
 * Same defensive pattern as the cloud-shade bridge: a missing helper only
 * leaves roofs unsnowed, never breaks the renderer.
 */
export function applyFacadeSeasonSafe(
  material: THREE.Material | null | undefined,
  uniforms: SeasonUniforms,
): void {
  if (!material) return;
  const apply = getFunction('applyFacadeSeason');
  if (apply) {
    try {
      apply(material, uniforms);
      return;
    } catch (error) {
      warnOnce('applyFacadeSeason threw; roofs keep their summer albedo', error);
    }
  }
}

/**
 * Push the per-frame facade uniforms through the module's update helper when
 * present, with a direct-uniform fallback for stubs / earlier builds.
 */
export function updateFacadeMaterialSafe(
  material: THREE.Material | null | undefined,
  patch: FacadeUniformPatch,
): void {
  if (!material) return;
  const update = getFunction('updateFacadeUniforms');
  if (update) {
    try {
      update(material, patch);
      return;
    } catch (error) {
      warnOnce('updateFacadeUniforms threw; falling back to direct uniform writes', error);
    }
  }
  applyFallbackUniforms(material, patch);
}

const FALLBACK_UNIFORM_NAMES: Record<keyof FacadeUniformPatch, string[]> = {
  night: ['uNight', 'night'],
  detailScale: ['uDetailScale', 'detailScale'],
  pixelSize: ['uPixelSize', 'pixelSize'],
  paletteMix: ['uPaletteMix', 'paletteMix'],
  timeHours: ['uTimeHours', 'timeHours'],
};

function applyFallbackUniforms(material: THREE.Material, patch: FacadeUniformPatch): void {
  const userData = material.userData as UnknownRecord | undefined;
  const uniforms =
    (userData?.uniforms as UnknownRecord | undefined) ??
    ((material as unknown as { uniforms?: UnknownRecord }).uniforms as
      | UnknownRecord
      | undefined);
  if (typeof patch.night === 'number' && userData) userData.night = patch.night;
  if (!uniforms) return;
  for (const key of Object.keys(patch) as Array<keyof FacadeUniformPatch>) {
    const value = patch[key];
    if (typeof value !== 'number') continue;
    for (const uniformName of FALLBACK_UNIFORM_NAMES[key]) {
      const uniform = uniforms[uniformName] as { value?: unknown } | undefined;
      if (uniform && typeof uniform === 'object' && 'value' in uniform) {
        uniform.value = value;
        break;
      }
    }
  }
}

export function disposeFacadeMaterialSafe(material: THREE.Material | null | undefined): void {
  if (!material) return;
  const dispose = getFunction('disposeFacadeMaterial');
  if (dispose) {
    try {
      dispose(material);
      return;
    } catch (error) {
      warnOnce('disposeFacadeMaterial threw; disposing directly', error);
    }
  }
  material.dispose();
}
