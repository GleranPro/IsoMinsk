/**
 * Drifting cloud shades.
 *
 * Shadows of clouds passing over the city, drawn purely in the surface shaders
 * (the Warsaw rule: atmosphere without second geometry). One shared tileable
 * noise texture is sampled by world XZ in the ground/environment/tree/facade
 * materials and darkens the lit albedo; the offset scrolls slowly with time so
 * the shade fields drift across the map. Lit windows stay lit: the darkening
 * applies to `diffuseColor` before lighting, not to the emissive term.
 *
 * All patched materials share ONE uniforms object, so the engine scrolls every
 * surface by assigning a single Vector2 per frame.
 */

import * as THREE from 'three';

/** Noise texture edge size (pixels). 256 is far beyond the pixel-art target. */
const NOISE_SIZE = 256;
/** World metres covered by one noise tile: cloud fields are ~1.4 km across. */
const NOISE_WORLD_SIZE_M = 1400;
/** Maximum darkening under the cloud core (0..1) — by day. */
export const CLOUD_MAX_DARKEN = 0.5;
/** Clouds block sun, not city glow: at full night the shade is damped. */
const NIGHT_DAMP = 0.35;
/** Drift speed, metres per second towards +X/-Z: fast enough that the shade
 * fields visibly cross the map within a minute. */
export const CLOUD_DRIFT_MPS = 9;

export interface CloudShadeUniforms {
  uCloudMap: THREE.IUniform<THREE.DataTexture>;
  uCloudOffset: THREE.IUniform<THREE.Vector2>;
  uCloudStrength: THREE.IUniform<number>;
}

// ---------------------------------------------------------------------------
// tileable noise
// ---------------------------------------------------------------------------

/** Deterministic 32-bit hash noise, 0..1. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const wrap = (v: number, periodValue: number): number =>
    ((v % periodValue) + periodValue) % periodValue;
  const x1 = wrap(x0 + 1, period);
  const y1 = wrap(y0 + 1, period);
  const xa = wrap(x0, period);
  const ya = wrap(y0, period);
  const n00 = hash2(xa, ya, seed);
  const n10 = hash2(x1, ya, seed);
  const n01 = hash2(xa, y1, seed);
  const n11 = hash2(x1, y1, seed);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

/**
 * Tileable 4-octave fbm in the red channel (green/blue carry decorrelated
 * octaves so the shader can pick a richer field without a second texture).
 */
export function createCloudNoiseTexture(size = NOISE_SIZE, seed = 20261120): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const basePeriod = 8;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * basePeriod;
      const v = (y / size) * basePeriod;
      let r = 0;
      let g = 0;
      let amplitude = 0.5;
      let period = basePeriod;
      for (let octave = 0; octave < 4; octave += 1) {
        r += valueNoise(u * (1 << octave), v * (1 << octave), period * (1 << octave), seed + octave * 7) * amplitude;
        g += valueNoise(u * (1 << octave) + 31.7, v * (1 << octave) + 11.3, period * (1 << octave), seed + 1000 + octave * 13) * amplitude;
        amplitude *= 0.5;
      }
      const index = (y * size + x) * 4;
      data[index] = Math.round(255 * Math.min(1, r));
      data[index + 1] = Math.round(255 * Math.min(1, g));
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = 'cloud-noise';
  return texture;
}

// ---------------------------------------------------------------------------
// shared uniforms
// ---------------------------------------------------------------------------

export function createCloudShadeUniforms(strength = 0): CloudShadeUniforms {
  return {
    uCloudMap: { value: createCloudNoiseTexture() },
    uCloudOffset: { value: new THREE.Vector2(0, 0) },
    uCloudStrength: { value: Math.min(1, Math.max(0, strength)) },
  };
}

// ---------------------------------------------------------------------------
// shader chunks
// ---------------------------------------------------------------------------

/** Vertex: pass world XZ + world-space normal to the fragment (instance-aware). */
export const CLOUD_VERTEX_GLSL = /* glsl */ `
varying vec3 vCloudWorld;
varying vec3 vCloudNormal;
`;

export const CLOUD_VERTEX_BODY_GLSL = /* glsl */ `
#ifdef USE_INSTANCING
  vCloudWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vCloudNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
#else
  vCloudWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vCloudNormal = normalize(mat3(modelMatrix) * objectNormal);
#endif
`;

/** Fragment declarations: uniforms + the shade mask helper. */
export const CLOUD_FRAGMENT_GLSL = /* glsl */ `
uniform sampler2D uCloudMap;
uniform vec2 uCloudOffset;
uniform float uCloudStrength;

varying vec3 vCloudWorld;
varying vec3 vCloudNormal;

float cloudShadeMask(vec2 worldXZ) {
  if (uCloudStrength < 0.001) return 0.0;
  float n = texture2D(uCloudMap, worldXZ / ${NOISE_WORLD_SIZE_M.toFixed(1)} + uCloudOffset).r;
  return smoothstep(0.42, 0.60, n);
}
`;

/**
 * Fragment statement: darken the lit albedo before lighting.
 *
 * Season snow is deliberately NOT here: the rejected winter mixed one cold
 * white into every up-facing surface. Snow is now a property of the ground
 * surface mask (see `seasons.ts` / `groundMaterial.ts`).
 */
export const CLOUD_DARKEN_GLSL = /* glsl */ `
diffuseColor.rgb *= 1.0 - clamp(uCloudStrength, 0.0, 1.0) * cloudShadeMask(vCloudWorld.xz) * ${CLOUD_MAX_DARKEN.toFixed(3)};
`;

/** Insert `insert` immediately after `anchor`; null when absent. */
function insertAfter(source: string, anchor: string, insert: string): string | null {
  const index = source.indexOf(anchor);
  if (index < 0) return null;
  const at = index + anchor.length;
  return source.slice(0, at) + '\n' + insert + '\n' + source.slice(at);
}

export interface CloudShadePatchOptions {
  /**
   * Anchor the darkening after this exact fragment statement instead of after
   * `#include <color_fragment>`. The facade shader replaces the stock chunk
   * with its own albedo block, so it needs a later anchor.
   */
  fragmentAfter?: string;
  /** Extra suffix for customProgramCacheKey (append to an existing key). */
  cacheKeySuffix?: string;
}

/**
 * Patch a (plain Lambert) material in place to receive the shared cloud
 * shade. Wraps any existing `onBeforeCompile` so facade-style materials keep
 * their own patches; call AFTER the material's own patch is installed.
 */
export function applyCloudShade(
  material: THREE.Material,
  uniforms: CloudShadeUniforms,
  options: CloudShadePatchOptions = {},
): void {
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (previousCompile) previousCompile(shader, renderer);
    shader.vertexShader = insertAfter(
      shader.vertexShader,
      '#include <common>',
      CLOUD_VERTEX_GLSL,
    ) ?? shader.vertexShader;
    shader.vertexShader = insertAfter(
      shader.vertexShader,
      '#include <project_vertex>',
      CLOUD_VERTEX_BODY_GLSL,
    ) ?? shader.vertexShader;
    shader.fragmentShader = insertAfter(
      shader.fragmentShader,
      '#include <common>',
      CLOUD_FRAGMENT_GLSL,
    ) ?? shader.fragmentShader;
    const anchor = options.fragmentAfter ?? '#include <color_fragment>';
    shader.fragmentShader = insertAfter(shader.fragmentShader, anchor, CLOUD_DARKEN_GLSL) ??
      shader.fragmentShader;
    Object.assign(shader.uniforms, uniforms);
  };
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () =>
    `${previousKey ? previousKey() : 'lambert'}+cloud${options.cacheKeySuffix ?? ''}`;
}

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

/**
 * Drives the shared uniforms: slow drift + smooth strength fades. One
 * controller per app; materials only hold the uniforms object.
 */
export class CloudShadeController {
  readonly uniforms: CloudShadeUniforms;
  private strength = 0;
  private targetStrength = 0;
  /** Night 0..1 from the time-of-day look; dampens the shade after sunset. */
  private night = 0;
  /** 0..1 zoom fade: patches of a few hundred metres read as grey noise at
   * city-overview zooms, so the shade fades out there (LOD by view size). */
  private zoomFade = 1;
  private drift = 0;

  constructor(uniforms: CloudShadeUniforms) {
    this.uniforms = uniforms;
    this.strength = uniforms.uCloudStrength.value;
    this.targetStrength = this.strength;
  }

  /** 0..1 requested shade intensity; fades smoothly to avoid a visual pop. */
  setStrength(value: number): void {
    this.targetStrength = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  /** Night 0..1 from the time-of-day look; weakens the shade at night. */
  setNight(value: number): void {
    this.night = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  /** Current ortho height: the shade fades out on city-overview zooms. */
  setOrthoHeight(value: number): void {
    const h = Number.isFinite(value) ? value : 0;
    const t = Math.min(1, Math.max(0, (h - 700) / (1500 - 700)));
    this.zoomFade = 1 - t * t * (3 - 2 * t);
  }

  getStrength(): number {
    return this.targetStrength;
  }

  /** Per-frame from the engine tick; seconds since the previous frame. */
  update(dtSeconds: number): void {
    const dt = Number.isFinite(dtSeconds) ? Math.min(dtSeconds, 0.25) : 0;
    // Fade at ~1/s: a toggle reads as clouds arriving/leaving, not a switch.
    const rate = Math.min(1, Math.abs(this.targetStrength - this.strength));
    this.strength += Math.sign(this.targetStrength - this.strength) * rate * dt;
    if (Math.abs(this.targetStrength - this.strength) < 0.002) this.strength = this.targetStrength;
    // Clouds block sunlight, not city glow (night), and their patches turn
    // into grey noise at overview zoom (zoom fade).
    this.uniforms.uCloudStrength.value =
      this.strength * (1 - NIGHT_DAMP * this.night) * this.zoomFade;

    this.drift += dt * CLOUD_DRIFT_MPS;
    const offset = this.uniforms.uCloudOffset.value as THREE.Vector2;
    // Offset in UV space; world scale is baked into the mask lookup.
    offset.set(this.drift / NOISE_WORLD_SIZE_M, (this.drift * 0.35) / NOISE_WORLD_SIZE_M);
  }

  dispose(): void {
    this.uniforms.uCloudMap.value.dispose();
  }
}
