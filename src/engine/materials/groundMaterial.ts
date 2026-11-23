/**
 * Raster ground material (payload 0.4.0).
 *
 * One flat quad per tile textured with the ground compositor output
 * (`src/city/ground/groundRaster.ts`). Lighting matches the vertex-coloured
 * environment material: stock Lambert with the same small emissive ambient
 * floor, so the textured ground and the remaining geometry (bridge decks,
 * trees) read as one surface family. Texels are sampled nearest-neighbour —
 * the pixel-art pipeline owns any smoothing.
 */

import * as THREE from 'three';
import { applyCloudShade, type CloudShadeUniforms } from '../renderer/cloudShade';
import type { SeasonUniforms } from '../renderer/seasonUniforms';

export const GROUND_EMISSIVE = new THREE.Color().setRGB(0.02, 0.022, 0.027);
/** Anisotropy for the oblique isometric view (clamped by the GPU's maximum). */
export const GROUND_ANISOTROPY = 8;

/** Fixed program cache key: every tile shares one compiled ground program. */
export const GROUND_SEASON_CACHE_KEY = 'ground-season-v1';

export function createGroundTexture(
  data: ArrayBuffer,
  width: number,
  height: number,
): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint8Array(data),
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  // Magnified (close zoom): crisp texels. Minified (a texel smaller than a
  // screen pixel, which happens along the foreshortened isometric depth axis):
  // trilinear + anisotropic filtering, otherwise nearest sampling skips texels
  // and 1-texel lane dashes break into random glyphs. The pixel-art post pass
  // quantises the result back onto the pixel grid.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = GROUND_ANISOTROPY;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// baked season mask (seasons P0)
// ---------------------------------------------------------------------------

/**
 * Season mask texture: RGBA8 *data*, not colour. Nearest magnification keeps
 * the class edge where the mask put it; mipmapped minification hides the
 * low-resolution mask at overview zooms without per-frame uploads.
 */
export function createSeasonTexture(
  data: ArrayBuffer,
  width: number,
  height: number,
): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint8Array(data),
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.name = 'season-mask';
  texture.needsUpdate = true;
  return texture;
}

let fallbackSeasonTexture: THREE.DataTexture | null = null;

/**
 * 1×1 mask for payloads without a baked mask (old tiles).
 *
 * The plan's sample values were class 128 / snow 220; we use class 0 / snow 0
 * instead so an old tile can never turn white even if winter is enabled
 * later — "unknown surface" must read as cleared, not as a lawn.
 */
export function seasonFallbackTexture(): THREE.DataTexture {
  if (!fallbackSeasonTexture) {
    const data = new Uint8Array([0, 0, 0, 0]);
    const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.flipY = false;
    texture.generateMipmaps = false;
    texture.userData.shared = true;
    texture.name = 'season-mask-fallback';
    texture.needsUpdate = true;
    fallbackSeasonTexture = texture;
  }
  return fallbackSeasonTexture;
}

/** Vertex declaration: world XZ for the snow hash (ground is not instanced). */
export const GROUND_SEASON_VERTEX_GLSL = /* glsl */ `
varying vec3 vSeasonWorld;
`;

export const GROUND_SEASON_VERTEX_BODY_GLSL = /* glsl */ `
vSeasonWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

/** Fragment declarations: mask sampler + shared season uniforms. */
export const GROUND_SEASON_FRAGMENT_GLSL = /* glsl */ `
uniform sampler2D uSeasonMap;
uniform float uWinter;
uniform float uAutumn;
uniform float uSnowCell;
uniform vec3 uSnowThin;
uniform vec3 uSnowDeep;
uniform vec3 uSnowShadow;
uniform vec3 uSnowDirty;
uniform vec3 uIce;
uniform vec3 uLeafA;
uniform vec3 uLeafB;
uniform vec3 uLeafC;
uniform vec3 uGrassAutumn;
uniform float uSeasonNight;

varying vec3 vSeasonWorld;

float seasonHash(vec2 p) {
  p = floor(p);
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

/** Smooth value noise: leaf clumps, not a per-texel checkerboard. */
float seasonValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = seasonHash(i);
  float b = seasonHash(i + vec2(1.0, 0.0));
  float c = seasonHash(i + vec2(0.0, 1.0));
  float d = seasonHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/**
 * Snow tint statement, inserted after `#include <map_fragment>`.
 *
 * Snow exists only where the baked mask allows it (R depth × B class gate):
 * asphalt (class 0) never receives it, open ground does. No albedo change on
 * walls, roofs or trees — this chunk lives in the ground material only.
 */
export const GROUND_SEASON_SNOW_GLSL = /* glsl */ `
if (uWinter > 0.001 || uAutumn > 0.001) {
  vec4 seasonSample = texture2D(uSeasonMap, vMapUv);
  float seasonClass = seasonSample.b;   // 0 asphalt .. 1 other
  float seasonDepth = seasonSample.r;   // 0 cleared .. 1 deepest
  float seasonWet = seasonSample.a;

  // Autumn: leaf litter on everything except asphalt, then a yellowing lawn.
  // The mask's G channel is the density; the shader only thresholds it on the
  // pixel grid so leaves stay crisp instead of becoming a soft gradient.
  if (uAutumn > 0.001) {
    float seasonLeaf = seasonSample.g * uAutumn * smoothstep(0.04, 0.18, seasonClass);
    float leafCell = max(1.2, uSnowCell * 0.9);
    vec2 leafP = vSeasonWorld.xz / leafCell;
    float leafNoise = seasonValueNoise(leafP);
    // Smooth density clumps: a hard per-texel threshold reads as a checker.
    seasonLeaf *= 0.55 + 0.45 * smoothstep(0.25, 0.75, leafNoise);
    float leafTone = seasonValueNoise(leafP * 0.63 + 37.0);
    vec3 leafColor = mix(uLeafA, uLeafB, smoothstep(0.2, 0.8, leafTone));
    leafColor = mix(leafColor, uLeafC, smoothstep(0.62, 0.9, leafTone));
    diffuseColor.rgb = mix(diffuseColor.rgb, leafColor, clamp(seasonLeaf, 0.0, 0.85));
    float seasonGrass = smoothstep(0.40, 0.55, seasonClass) * (1.0 - step(0.70, seasonClass));
    diffuseColor.rgb = mix(diffuseColor.rgb, uGrassAutumn, seasonGrass * uAutumn * 0.30);
  }

  if (uWinter > 0.001) {
    float seasonGate = smoothstep(0.08, 0.22, seasonClass);
    float seasonNoise = seasonHash(vSeasonWorld.xz / max(0.75, uSnowCell));
    float seasonCover = seasonDepth * seasonGate;
    seasonCover = smoothstep(0.18, 0.42, seasonCover + (seasonNoise - 0.5) * 0.18);
    // Three coverage steps; the pixel-art post pass owns the final dither.
    seasonCover = floor(seasonCover * 3.0 + 0.5) / 3.0;
    vec3 seasonSnow = mix(uSnowThin, uSnowDeep, seasonDepth);
    seasonSnow = mix(seasonSnow, uSnowShadow, (1.0 - seasonGate) * 0.35);
    seasonSnow = mix(seasonSnow, uSnowDirty, seasonWet * 0.55);
    // Water: bank ice (R=255 at the shore) in blue-grey, a dark middle (R=0).
    float seasonWater = step(0.70, seasonClass) * (1.0 - step(0.85, seasonClass));
    seasonSnow = mix(seasonSnow, uIce, seasonWater * 0.85);
    diffuseColor.rgb = mix(diffuseColor.rgb, seasonSnow, seasonCover * uWinter);
    // Snow reflects a little sky at night; the lift is tiny and snow-only, so
    // the city stays dark and the windows still carry the night look.
    totalEmissiveRadiance += seasonSnow * seasonCover * uWinter * uSeasonNight * 0.035;
  }

  // Wet asphalt and dirty slush read darker than dry summer ground.
  diffuseColor.rgb *= 1.0 - seasonWet * 0.12 * clamp(uWinter + uAutumn, 0.0, 1.0);
}
`;

/** Insert `insert` immediately after `anchor`; unchanged when absent. */
function insertShaderAfter(source: string, anchor: string, insert: string): string {
  const index = source.indexOf(anchor);
  if (index < 0) return source;
  const at = index + anchor.length;
  return source.slice(0, at) + '\n' + insert + '\n' + source.slice(at);
}

/**
 * Patch a ground material with the baked season mask. One shared uniforms
 * object drives every tile; the texture is per tile and never re-uploaded.
 */
export function applyGroundSeason(
  material: THREE.Material,
  seasonTexture: THREE.Texture,
  uniforms: SeasonUniforms,
): void {
  material.userData.seasonTexture = seasonTexture;
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (previousCompile) previousCompile(shader, renderer);
    shader.vertexShader = insertShaderAfter(
      shader.vertexShader,
      '#include <common>',
      GROUND_SEASON_VERTEX_GLSL,
    );
    shader.vertexShader = insertShaderAfter(
      shader.vertexShader,
      '#include <project_vertex>',
      GROUND_SEASON_VERTEX_BODY_GLSL,
    );
    shader.fragmentShader = insertShaderAfter(
      shader.fragmentShader,
      '#include <common>',
      GROUND_SEASON_FRAGMENT_GLSL,
    );
    shader.fragmentShader = insertShaderAfter(
      shader.fragmentShader,
      '#include <map_fragment>',
      GROUND_SEASON_SNOW_GLSL,
    );
    shader.uniforms.uSeasonMap = { value: seasonTexture };
    Object.assign(shader.uniforms, uniforms);
  };
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () =>
    `${previousKey ? previousKey() : 'lambert'}+${GROUND_SEASON_CACHE_KEY}`;
}

export interface GroundMaterialOptions {
  clouds?: CloudShadeUniforms;
  /** Shared season uniforms; omitted leaves the ground unpatched (tests). */
  season?: SeasonUniforms;
  /** Baked per-tile mask; the no-snow fallback is used when absent. */
  seasonTexture?: THREE.Texture | null;
}

export function createGroundMaterial(
  texture: THREE.Texture,
  options: GroundMaterialOptions = {},
): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    map: texture,
    fog: true,
    emissive: GROUND_EMISSIVE.clone(),
  });
  material.name = 'IsometricMinskRasterGround';
  if (options.season) {
    applyGroundSeason(material, options.seasonTexture ?? seasonFallbackTexture(), options.season);
  }
  if (options.clouds) applyCloudShade(material, options.clouds);
  return material;
}

/** Dispose a ground/deck material, its tile texture and its season mask. */
export function disposeGroundMaterial(material: THREE.Material): void {
  (material as THREE.MeshLambertMaterial).map?.dispose();
  const seasonTexture = material.userData.seasonTexture as THREE.Texture | undefined;
  if (seasonTexture && !seasonTexture.userData.shared) seasonTexture.dispose();
  material.dispose();
}

/**
 * Flat quad covering `bounds` (local metres) at height `y`, in renderer world
 * space (x east, y up, z = -north). UV (0,0) is the north-west corner, matching
 * the compositor's row 0 = north edge.
 */
export function createGroundQuad(
  bounds: [number, number, number, number],
  y: number,
): THREE.BufferGeometry {
  const [x0, y0, x1, y1] = bounds;
  // A(x0, north) B(x1, north) C(x1, south) D(x0, south)
  const positions = new Float32Array([
    x0, y, -y1,
    x0, y, -y0,
    x1, y, -y0,
    x0, y, -y1,
    x1, y, -y0,
    x1, y, -y1,
  ]);
  const uvs = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
  const normals = new Float32Array(18);
  for (let i = 1; i < 18; i += 3) normals[i] = 1;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}
