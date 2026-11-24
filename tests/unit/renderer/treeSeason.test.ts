import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  applyTreeSeason,
  TREE_SEASON_CACHE_KEY,
  TREE_SEASON_SNOW_GLSL,
  TREE_SEASON_VERTEX_BODY_GLSL,
} from '../../../src/engine/materials/treeSeason';
import { createSeasonUniforms } from '../../../src/engine/renderer/seasonUniforms';

describe('tree season snow', () => {
  it('is instancing-aware and settles snow by world-up', () => {
    expect(TREE_SEASON_VERTEX_BODY_GLSL).toContain('USE_INSTANCING');
    expect(TREE_SEASON_VERTEX_BODY_GLSL).toContain('instanceMatrix');
    expect(TREE_SEASON_VERTEX_BODY_GLSL).toContain('objectNormal');
    expect(TREE_SEASON_SNOW_GLSL).toContain('vTreeWorldUp');
    expect(TREE_SEASON_SNOW_GLSL).toContain('uWinter');
    expect(TREE_SEASON_SNOW_GLSL).toContain('uSnowDeep');
    // Ground/facade paths must stay out of the tree material.
    expect(TREE_SEASON_SNOW_GLSL).not.toContain('vFacade');
    expect(TREE_SEASON_SNOW_GLSL).not.toContain('uSeasonMap');
  });

  it('shares the season uniforms and one fixed program key', () => {
    const uniforms = createSeasonUniforms();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    applyTreeSeason(material, uniforms);
    expect(typeof material.onBeforeCompile).toBe('function');
    expect(material.customProgramCacheKey()).toContain(TREE_SEASON_CACHE_KEY);
    material.dispose();
  });
});
