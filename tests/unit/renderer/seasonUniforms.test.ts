import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  createGroundMaterial,
  GROUND_SEASON_CACHE_KEY,
  GROUND_SEASON_SNOW_GLSL,
  seasonFallbackTexture,
} from '../../../src/engine/materials/groundMaterial';
import {
  createSeasonUniforms,
  updateSeasonUniforms,
  updateSnowCell,
} from '../../../src/engine/renderer/seasonUniforms';
import { seasonWeights } from '../../../src/engine/renderer/seasons';

describe('season uniforms', () => {
  it('boots with winter and autumn switched off', () => {
    const uniforms = createSeasonUniforms();
    expect(uniforms.uWinter.value).toBe(0);
    expect(uniforms.uAutumn.value).toBe(0);
    expect(uniforms.uSnowCell.value).toBe(0.75);
    expect(uniforms.uLeafA.value).toBeInstanceOf(THREE.Color);
    expect(uniforms.uGrassAutumn.value).toBeInstanceOf(THREE.Color);
  });

  it('applies continuous season weights without touching the date', () => {
    const uniforms = createSeasonUniforms();
    updateSeasonUniforms(uniforms, seasonWeights(new Date('2027-01-15T00:00:00Z')));
    expect(uniforms.uWinter.value).toBeCloseTo(0.828, 2);
    expect(uniforms.uAutumn.value).toBe(0);
    updateSeasonUniforms(uniforms, seasonWeights(new Date('2026-10-15T00:00:00Z')));
    expect(uniforms.uWinter.value).toBe(0);
    expect(uniforms.uAutumn.value).toBeGreaterThan(0.4);
  });

  it('keeps the snow cell on the pixel grid', () => {
    const uniforms = createSeasonUniforms();
    updateSnowCell(uniforms, 0.1);
    expect(uniforms.uSnowCell.value).toBe(0.75);
    updateSnowCell(uniforms, 2);
    expect(uniforms.uSnowCell.value).toBe(3);
    updateSnowCell(uniforms, Number.NaN);
    expect(uniforms.uSnowCell.value).toBe(0.75);
  });
});

describe('ground season shader', () => {
  it('gates snow on the mask depth and class only', () => {
    expect(GROUND_SEASON_SNOW_GLSL).toContain('texture2D(uSeasonMap, vMapUv)');
    expect(GROUND_SEASON_SNOW_GLSL).toContain('seasonSample.r');
    expect(GROUND_SEASON_SNOW_GLSL).toContain('seasonSample.b');
    expect(GROUND_SEASON_SNOW_GLSL).toContain('smoothstep(0.08, 0.22, seasonClass)');
    expect(GROUND_SEASON_SNOW_GLSL).toContain('uWinter');
    // No global emissive: the only lift is the faint night sky reflection on
    // snow cover (snow × cover × winter × night), never a scene-wide glow.
    expect(GROUND_SEASON_SNOW_GLSL).toContain(
      'totalEmissiveRadiance += seasonSnow * step(0.99, seasonCover) * uWinter * uSeasonNight',
    );
    expect(GROUND_SEASON_SNOW_GLSL).not.toContain('vCloudNormal');
    expect(GROUND_SEASON_SNOW_GLSL).not.toContain('uSnowAmount');
  });

  it('reads leaf litter and wetness from the same mask without touching asphalt', () => {
    expect(GROUND_SEASON_SNOW_GLSL).toContain('seasonSample.g');
    expect(GROUND_SEASON_SNOW_GLSL).toContain('uLeafA');
    expect(GROUND_SEASON_SNOW_GLSL).toContain('uGrassAutumn');
    expect(GROUND_SEASON_SNOW_GLSL).toContain('smoothstep(0.04, 0.18, seasonClass)');
    expect(GROUND_SEASON_SNOW_GLSL).toContain('uAutumn > 0.001');
    expect(GROUND_SEASON_SNOW_GLSL).toContain('seasonWet * 0.12');
  });

  it('installs one shared program key and a no-snow fallback', () => {
    const uniforms = createSeasonUniforms();
    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    const material = createGroundMaterial(texture, { season: uniforms });
    expect(material.customProgramCacheKey()).toContain(GROUND_SEASON_CACHE_KEY);
    expect(material.userData.seasonTexture).toBe(seasonFallbackTexture());
    // The fallback reads as "unknown = cleared": snow 0, class asphalt 0.
    const fallback = seasonFallbackTexture();
    expect(Array.from(fallback.image.data as Uint8Array)).toEqual([0, 0, 0, 0]);
    expect(fallback.userData.shared).toBe(true);
    expect(seasonFallbackTexture()).toBe(fallback);
    material.dispose();
  });
});
