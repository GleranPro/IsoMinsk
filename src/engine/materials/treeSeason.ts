/**
 * Snow on tree canopies and bare winter branches (seasons P3).
 *
 * Applied to the shared instanced tree-canopy material, mirroring the cloud
 * shade patch: one uniforms object, one fixed program key. Summer broadleaf
 * crowns are hidden in winter (see `instancedTrees.ts`), so this shader is what
 * puts snow on conifers and on the `createWinterCrownTemplate` branches.
 *
 * The vertex path handles `USE_INSTANCING`: world position and up-normal come
 * from the instance matrix, so a single draw call per crown batch gets correct
 * per-tree coverage.
 */

import * as THREE from 'three';
import type { SeasonUniforms } from '../renderer/seasonUniforms';

/** Fixed program cache key: all tree batches share one compiled program. */
export const TREE_SEASON_CACHE_KEY = 'tree-season-v1';

export const TREE_SEASON_VERTEX_GLSL = /* glsl */ `
// 1 on bare winter branches (createWinterCrownTemplate), 0 on needles/leaves.
attribute float aWinterBranch;

varying vec3 vTreeWorldPos;
varying float vTreeWorldUp;
varying float vTreeWinterBranch;
`;

export const TREE_SEASON_VERTEX_BODY_GLSL = /* glsl */ `
vTreeWinterBranch = aWinterBranch;
#ifdef USE_INSTANCING
  vTreeWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vTreeWorldUp = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal).y;
#else
  vTreeWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vTreeWorldUp = normalize(mat3(modelMatrix) * objectNormal).y;
#endif
`;

export const TREE_SEASON_FRAGMENT_GLSL = /* glsl */ `
uniform float uWinter;
uniform float uSnowCell;
uniform vec3 uSnowDeep;
uniform vec3 uSnowShadow;

varying vec3 vTreeWorldPos;
varying float vTreeWorldUp;
varying float vTreeWinterBranch;

float treeSeasonHash(vec2 p) {
  p = floor(p);
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
`;

/**
 * Snow cap on the canopy/branches. Winter branches carry upward-biased
 * normals, so the same up-gate reads as snow resting on twigs; conifers keep
 * their own up-facing lobes. Three quantised steps, dithered by the post pass.
 */
export const TREE_SEASON_SNOW_GLSL = /* glsl */ `
float treeSeasonUp = clamp(vTreeWorldUp, 0.0, 1.0);
float treeSeasonNoise = treeSeasonHash(vTreeWorldPos.xz / max(0.75, uSnowCell));
float treeSeasonCap = uWinter
  * smoothstep(0.25, 0.75, treeSeasonUp)
  * smoothstep(0.26, 0.56, treeSeasonNoise + 0.35 * treeSeasonUp);
treeSeasonCap = floor(treeSeasonCap * 3.0 + 0.5) / 3.0;
vec3 treeSeasonSnow = mix(uSnowShadow, uSnowDeep, smoothstep(0.15, 0.9, treeSeasonUp));
// Conifers take a nearly full cap; bare branches keep a third of their dark
// bark so they still read as branches under the snow.
float treeSeasonMix = mix(0.90, 0.66, clamp(vTreeWinterBranch, 0.0, 1.0));
diffuseColor.rgb = mix(diffuseColor.rgb, treeSeasonSnow, treeSeasonCap * treeSeasonMix);
`;

/** Insert `insert` immediately after `anchor`; unchanged when absent. */
function insertShaderAfter(source: string, anchor: string, insert: string): string {
  const index = source.indexOf(anchor);
  if (index < 0) return source;
  const at = index + anchor.length;
  return source.slice(0, at) + '\n' + insert + '\n' + source.slice(at);
}

/** Patch the shared tree-canopy material with the winter snow cap. */
export function applyTreeSeason(
  material: THREE.Material,
  uniforms: SeasonUniforms,
): void {
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (previousCompile) previousCompile(shader, renderer);
    shader.vertexShader = insertShaderAfter(
      shader.vertexShader,
      '#include <common>',
      TREE_SEASON_VERTEX_GLSL,
    );
    shader.vertexShader = insertShaderAfter(
      shader.vertexShader,
      '#include <project_vertex>',
      TREE_SEASON_VERTEX_BODY_GLSL,
    );
    shader.fragmentShader = insertShaderAfter(
      shader.fragmentShader,
      '#include <common>',
      TREE_SEASON_FRAGMENT_GLSL,
    );
    shader.fragmentShader = insertShaderAfter(
      shader.fragmentShader,
      '#include <color_fragment>',
      TREE_SEASON_SNOW_GLSL,
    );
    Object.assign(shader.uniforms, uniforms);
  };
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () =>
    `${previousKey ? previousKey() : 'lambert'}+${TREE_SEASON_CACHE_KEY}`;
}
