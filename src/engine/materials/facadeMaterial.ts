/**
 * Isometric Minsk — facade & environment materials.
 *
 * The facade is a procedural GLSL material: a `MeshLambertMaterial` extended
 * through `onBeforeCompile` (see src/engine/shaders/facadeShader.ts). Extending
 * the built-in Lambert pipeline keeps sun shadows, fog and tone mapping for
 * free — we only replace the albedo / emissive computation and add palette
 * quantisation at the end of the fragment shader.
 *
 * Public API (keep stable — the renderer module codes against it):
 *   createFacadeMaterial(options): THREE.Material
 *   updateFacadeUniforms(material, uniforms): void
 *   disposeFacadeMaterial(material): void
 *   createEnvironmentMaterial(): THREE.Material
 *
 * Uniforms the renderer must push to the facade material via
 * `updateFacadeUniforms` (all optional, unknown keys are ignored):
 *   night       number  0..1   lit-window ratio; drive from TIME_OF_DAY_PRESETS.nightFactor
 *   detailScale number  0..1   1 = procedural windows, 0 = plain tinted walls (debug toggle)
 *   pixelSize   number  >0     world metres per screen pixel; exact ortho value:
 *                              (2 * camera.orthoHeight) / renderTargetHeightPx
 *   paletteMix  number  0..1   in-material palette quantisation amount (0 = off, avoids
 *                              double quantisation when the post pass also quantises)
 *   timeHours   number  0..24  local solar time (warm low-sun glass reflections)
 *
 * The material also exposes its uniform objects at
 * `material.userData.facadeUniforms` (alias `material.userData.uniforms`) for
 * advanced wiring; prefer `updateFacadeUniforms` so values stay clamped.
 *
 * Ownership: facades / art-direction module.
 */

import * as THREE from 'three';
import type { Archetype } from '../../shared/types';
import { ARCHETYPE_BY_ID } from '../../shared/geometry';
import { FACADE_PRESET_COUNT } from '../../shared/buildingStyles';
import { motifRowsForUniforms, presetRowsForUniforms } from '../../city/facades/presets';
import { hexToRgb, PIXEL_PALETTE, paletteToFloat32 } from '../postprocess/palette';
import {
  FACADE_FRAGMENT_ALBEDO_TAIL,
  FACADE_PROGRAM_CACHE_KEY,
  patchFacadeFragmentShader,
  patchFacadeVertexShader,
} from '../shaders/facadeShader';
import { applyCloudShade, type CloudShadeUniforms } from '../renderer/cloudShade';
import { FACADE_TRIM_COLOR, WINDOW_COLORS } from './palette';

export interface FacadeMaterialOptions {
  /** Enable procedural windows / facade detail. */
  detail: boolean;
  /** 0..1 night factor: how many windows are lit. */
  night: number;
  /** Quantise facade colours for the pixel-art look (default true). */
  quantise?: boolean;
}

/** Uniforms exposed by the facade shader. */
export interface FacadeUniformSet {
  uNight: THREE.IUniform<number>;
  uDetailScale: THREE.IUniform<number>;
  uPixelSize: THREE.IUniform<number>;
  uPaletteMix: THREE.IUniform<number>;
  uTimeHours: THREE.IUniform<number>;
  /**
   * vec4[41]: bayWidth, windowWidthRatio, windowHeightRatio, sillRatio, indexed
   * by the packed recipe id (27 families + 11 legacy presets + 3 shells).
   */
  uPresetA: THREE.IUniform<Float32Array>;
  /** vec4[41]: floorHeight, groundFloorHeight, balconyRatio, corniceHeight. */
  uPresetB: THREE.IUniform<Float32Array>;
  /** float[41]: shader motif id per recipe row (-1 = legacy archetype preset). */
  uRecipeMotif: THREE.IUniform<Float32Array>;
  uGlassColor: THREE.IUniform<THREE.Vector3>;
  uGlassLightColor: THREE.IUniform<THREE.Vector3>;
  uNightDarkColor: THREE.IUniform<THREE.Vector3>;
  uNightLitColor: THREE.IUniform<THREE.Vector3>;
  uNightWarmColor: THREE.IUniform<THREE.Vector3>;
  uShopfrontColor: THREE.IUniform<THREE.Vector3>;
  uTrimColor: THREE.IUniform<THREE.Vector3>;
  /** vec3[PIXEL_PALETTE_SIZE]: display-sRGB palette for in-shader quantisation. */
  uPalette: THREE.IUniform<Float32Array>;
  [uniform: string]: THREE.IUniform;
}

/** Partial uniform updates accepted by {@link updateFacadeUniforms}. */
export interface FacadeUniformUpdates {
  /** 0..1 night factor: how many windows are lit. */
  night?: number;
  /** 0..1 detail LOD (0 = flat tinted walls, no windows). */
  detailScale?: number;
  /** World metres per screen pixel at the current zoom. */
  pixelSize?: number;
  /** 0..1 palette quantisation amount (0 = off, prevents double quantisation). */
  paletteMix?: number;
  /** Local solar time 0..24, used for warm low-sun glass reflections. */
  timeHours?: number;
}

/** Last-resort default, used until the renderer reports a zoom-dependent value. */
const DEFAULT_PIXEL_SIZE_M = 0.12;

/** One vec3 uniform holding raw display-sRGB channels (the shader linearises). */
function srgbVec3(hex: string): THREE.Vector3 {
  const { r, g, b } = hexToRgb(hex);
  return new THREE.Vector3(r / 255, g / 255, b / 255);
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function buildPresetUniforms(): { a: Float32Array; b: Float32Array; motif: Float32Array } {
  const rows = presetRowsForUniforms();
  const a = new Float32Array(rows.length * 4);
  const b = new Float32Array(rows.length * 4);
  for (let i = 0; i < rows.length; i++) {
    const preset = rows[i];
    a[i * 4] = preset.bayWidth;
    a[i * 4 + 1] = preset.windowWidthRatio;
    a[i * 4 + 2] = preset.windowHeightRatio;
    a[i * 4 + 3] = preset.sillRatio;
    b[i * 4] = preset.floorHeight;
    b[i * 4 + 1] = preset.groundFloorHeight;
    b[i * 4 + 2] = preset.balconyRatio;
    b[i * 4 + 3] = preset.corniceHeight;
  }
  if (rows.length !== FACADE_PRESET_COUNT) {
    throw new Error(`facade preset rows ${rows.length} != ${FACADE_PRESET_COUNT}`);
  }
  return { a, b, motif: motifRowsForUniforms() };
}

/**
 * Build the uniform set for a facade material. Exported for tests and for
 * advanced renderer wiring; normally use {@link createFacadeMaterial}.
 */
export function createFacadeUniforms(options: {
  detail: boolean;
  night: number;
  quantise: boolean;
}): FacadeUniformSet {
  const presets = buildPresetUniforms();
  return {
    uNight: { value: clamp(finiteOr(options.night, 0), 0, 1) },
    uDetailScale: { value: options.detail ? 1 : 0 },
    uPixelSize: { value: DEFAULT_PIXEL_SIZE_M },
    uPaletteMix: { value: options.quantise ? 1 : 0 },
    uTimeHours: { value: 13 },
    uPresetA: { value: presets.a },
    uPresetB: { value: presets.b },
    uRecipeMotif: { value: presets.motif },
    uGlassColor: { value: srgbVec3(WINDOW_COLORS.glass) },
    uGlassLightColor: { value: srgbVec3(WINDOW_COLORS.glassLight) },
    uNightDarkColor: { value: srgbVec3(WINDOW_COLORS.nightDark) },
    uNightLitColor: { value: srgbVec3(WINDOW_COLORS.nightLit) },
    uNightWarmColor: { value: srgbVec3(WINDOW_COLORS.nightLitWarm) },
    uShopfrontColor: { value: srgbVec3(WINDOW_COLORS.shopfront) },
    uTrimColor: { value: srgbVec3(FACADE_TRIM_COLOR) },
    uPalette: { value: paletteToFloat32(PIXEL_PALETTE) },
  };
}

/**
 * Create the procedural facade material.
 *
 * Returns a MeshLambertMaterial so that `material.color`, `material.wireframe`
 * and `material.fog` keep working for the debug controls; the facade look comes
 * entirely from the patched shader.
 */
export function createFacadeMaterial(options: FacadeMaterialOptions): THREE.Material {
  const detail = options?.detail !== false;
  const night = clamp(finiteOr(options?.night, 0), 0, 1);
  const quantise = options?.quantise !== false;
  const uniforms = createFacadeUniforms({ detail, night, quantise });

  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: false,
    flatShading: true,
    fog: true,
  });
  material.name = 'IsometricMinskFacade';
  material.userData.facadeUniforms = uniforms;
  // Compatibility alias: older engine code pokes material.userData.uniforms.uNight.
  material.userData.uniforms = uniforms;
  material.userData.detail = detail;
  material.userData.night = night;

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = patchFacadeVertexShader(shader.vertexShader);
    shader.fragmentShader = patchFacadeFragmentShader(shader.fragmentShader);
    Object.assign(shader.uniforms, uniforms);
  };
  material.customProgramCacheKey = () => FACADE_PROGRAM_CACHE_KEY;

  return material;
}

/**
 * Wire the shared cloud-shade uniforms into a facade material. The darkening
 * anchors after the facade albedo block (lit windows stay lit), so this must
 * run before the material's first compile and only after `onBeforeCompile` is
 * installed (it wraps the facade patch).
 */
export function applyFacadeCloudShade(
  material: THREE.Material,
  uniforms: CloudShadeUniforms,
): void {
  applyCloudShade(material, uniforms, {
    fragmentAfter: FACADE_FRAGMENT_ALBEDO_TAIL,
    cacheKeySuffix: '-facade',
  });
}

function getFacadeUniformSet(material: THREE.Material | undefined | null): FacadeUniformSet | null {
  if (!material || typeof material !== 'object') return null;
  const userData = material.userData as
    | { facadeUniforms?: FacadeUniformSet; uniforms?: FacadeUniformSet }
    | undefined;
  const candidate = userData?.facadeUniforms ?? userData?.uniforms;
  if (!candidate || typeof candidate !== 'object') return null;
  const night = (candidate as FacadeUniformSet).uNight;
  return night && typeof night.value === 'number' ? candidate : null;
}

/**
 * Update facade uniforms after creation (time of day, zoom, detail toggle,
 * palette mix). Safe no-op on materials that do not carry facade uniforms or
 * on unknown update keys.
 */
export function updateFacadeUniforms(
  material: THREE.Material,
  uniforms: FacadeUniformUpdates,
): void {
  const set = getFacadeUniformSet(material);
  if (!set || !uniforms || typeof uniforms !== 'object') return;

  const night = finiteOr(uniforms.night, Number.NaN);
  if (!Number.isNaN(night)) {
    set.uNight.value = clamp(night, 0, 1);
    material.userData.night = set.uNight.value;
  }
  const detailScale = finiteOr(uniforms.detailScale, Number.NaN);
  if (!Number.isNaN(detailScale)) {
    set.uDetailScale.value = clamp(detailScale, 0, 1);
    material.userData.detail = set.uDetailScale.value > 0.001;
  }
  const pixelSize = finiteOr(uniforms.pixelSize, Number.NaN);
  if (!Number.isNaN(pixelSize)) {
    // Clamp to a sane range: sub-millimetre and multi-metre-per-pixel values
    // would only produce numerical noise in the shader.
    set.uPixelSize.value = clamp(pixelSize, 0.001, 8);
  }
  const paletteMix = finiteOr(uniforms.paletteMix, Number.NaN);
  if (!Number.isNaN(paletteMix)) {
    set.uPaletteMix.value = clamp(paletteMix, 0, 1);
  }
  const timeHours = finiteOr(uniforms.timeHours, Number.NaN);
  if (!Number.isNaN(timeHours)) {
    set.uTimeHours.value = ((timeHours % 24) + 24) % 24;
  }
}

/** Dispose the facade material. Safe to call on any material. */
export function disposeFacadeMaterial(material: THREE.Material): void {
  if (!material) return;
  material.dispose();
}

/**
 * Vertex-coloured, flat-shaded material for ground / roads / water / trees.
 *
 * Plain stock MeshLambertMaterial: the environment mesh builder emits the
 * standard Three.js `color` attribute in linear RGB, so the stock
 * `<color_fragment>` chunk applies it exactly once. (An earlier custom patch
 * also read the project's `aColor` attribute and multiplied the same colour a
 * second time, which crushed roads/water to black — do not reintroduce a patch
 * here without also dropping one of the colour attributes on the mesh side.)
 *
 * A very small constant `emissive` acts as a stylised ambient floor: with the
 * low winter sun most streets and courtyards are in building shadow, and real
 * Lambert lighting + tone mapping would crush them to near-black. The lift is
 * additive (not a second colour multiply) and preserves the vertex-colour hue
 * variation, so roads, pavements and grass stay distinguishable in shadow.
 */
export function createEnvironmentMaterial(): THREE.Material {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    fog: true,
    emissive: new THREE.Color().setRGB(0.020, 0.022, 0.027),
  });
  material.name = 'IsometricMinskEnvironment';
  return material;
}

/** Shared material registry so tiles can share GPU resources. */
export interface MaterialSet {
  facade: THREE.Material;
  environment: THREE.Material;
  dispose(): void;
}

/**
 * Convenience factory used by the engine bootstrap: one facade material and one
 * environment material shared by every tile, with a single dispose().
 */
export function createMaterialSet(options: FacadeMaterialOptions): MaterialSet {
  const facade = createFacadeMaterial(options);
  const environment = createEnvironmentMaterial();
  return {
    facade,
    environment,
    dispose() {
      disposeFacadeMaterial(facade);
      environment.dispose();
    },
  };
}
