/**
 * Shared season uniforms (seasons P0).
 *
 * ONE uniforms object is patched into every season-aware material — the
 * raster ground today, facades/trees in later phases — mirroring the cloud
 * shade pattern. `uWinter` is 0 by default: the shader path is installed and
 * ready, but nothing whitens the city until the designed winter content
 * (roads, pavements, roofs) is accepted. The rejected attempt fed a global
 * `uSnowAmount` to every up-facing surface; this object only parameterises the
 * per-surface mask (`paintSeasonMask` in `src/city/ground/groundRaster.ts`).
 *
 * Colours are linear: `THREE.Color` converts the sRGB hex once.
 */

import * as THREE from 'three';
import type { SeasonWeights } from './seasons';

export interface SeasonUniforms {
  /** 0..1 snow-depth multiplier (`winterMix`); 0 leaves the summer look. */
  uWinter: THREE.IUniform<number>;
  /** 0..1 autumn phase (litter/grass palette); unused by the P0 ground shader. */
  uAutumn: THREE.IUniform<number>;
  /** World metres per snow-detail cell: `max(0.75, worldPerPixel * 1.5)`. */
  uSnowCell: THREE.IUniform<number>;
  /** Thin cover on pavements. */
  uSnowThin: THREE.IUniform<THREE.Color>;
  /** Deep, untouched cover on lawns and parks. */
  uSnowDeep: THREE.IUniform<THREE.Color>;
  /** Cold shade on cleared edges. */
  uSnowShadow: THREE.IUniform<THREE.Color>;
  /** Slush / dirty snow near the kerb. */
  uSnowDirty: THREE.IUniform<THREE.Color>;
  /** Blue-grey river/lake ice; water never reads as white snow. */
  uIce: THREE.IUniform<THREE.Color>;
  /** Autumn leaf-litter tones (display palette, linearised once). */
  uLeafA: THREE.IUniform<THREE.Color>;
  uLeafB: THREE.IUniform<THREE.Color>;
  uLeafC: THREE.IUniform<THREE.Color>;
  /** Yellow-brown autumn lawn tint. */
  uGrassAutumn: THREE.IUniform<THREE.Color>;
}

/** Cold whites from the pixel palette (docs/SEASONS_TECHNICAL_PLAN.md §9.5). */
export const SNOW_COLORS = {
  thin: '#cfdae1',
  deep: '#eef4f7',
  shadow: '#93a4b2',
  dirty: '#b3ab9a',
  ice: '#8fa6b3',
} as const;

/** Leaf-litter / autumn lawn tones (same family as the broadleaf palette). */
export const AUTUMN_COLORS = {
  leafA: '#c9a13b',
  leafB: '#c07a32',
  leafC: '#9a5a2e',
  grass: '#b7a05a',
} as const;

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function createSeasonUniforms(weights?: SeasonWeights): SeasonUniforms {
  return {
    uWinter: { value: clamp01(weights?.winterMix ?? 0) },
    uAutumn: { value: clamp01(weights?.autumnMix ?? 0) },
    uSnowCell: { value: 0.75 },
    uSnowThin: { value: new THREE.Color(SNOW_COLORS.thin) },
    uSnowDeep: { value: new THREE.Color(SNOW_COLORS.deep) },
    uSnowShadow: { value: new THREE.Color(SNOW_COLORS.shadow) },
    uSnowDirty: { value: new THREE.Color(SNOW_COLORS.dirty) },
    uIce: { value: new THREE.Color(SNOW_COLORS.ice) },
    uLeafA: { value: new THREE.Color(AUTUMN_COLORS.leafA) },
    uLeafB: { value: new THREE.Color(AUTUMN_COLORS.leafB) },
    uLeafC: { value: new THREE.Color(AUTUMN_COLORS.leafC) },
    uGrassAutumn: { value: new THREE.Color(AUTUMN_COLORS.grass) },
  };
}

/** Apply continuous season weights (call when the season/date changes). */
export function updateSeasonUniforms(
  uniforms: SeasonUniforms,
  weights: SeasonWeights,
): void {
  uniforms.uWinter.value = clamp01(weights.winterMix);
  uniforms.uAutumn.value = clamp01(weights.autumnMix);
}

/**
 * Keep the snow detail cell tied to the pixel grid: too small and the hash
 * flickers at overview zooms, too large and it smears into blobs up close.
 */
export function updateSnowCell(uniforms: SeasonUniforms, worldPerPixel: number): void {
  const wpp = Number.isFinite(worldPerPixel) && worldPerPixel > 0 ? worldPerPixel : 0;
  uniforms.uSnowCell.value = Math.max(0.75, wpp * 1.5);
}
