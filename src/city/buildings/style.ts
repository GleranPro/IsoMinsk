/**
 * Per-building style context + vertex attribute surfaces.
 *
 * Colours follow src/shared/geometry.ts: `aColor` carries **sRGB** values in
 * 0..1 (the facade shader linearises in GLSL). Facade values come from the
 * recipe-driven preset rows (`src/city/facades/presets.ts`), so a legacy tile
 * reproduces its exact previous preset and a family recipe gets its own rhythm
 * and coordinated palette.
 *
 * Packing contract: `BuildingStyle.flags` holds the *packed* style integer
 * (`flags | recipeId << 8`) written straight into `aFace.y`. Consumers that test
 * a flag must mask the low byte — which is automatic for single-bit tests
 * (`packed & STYLE_FLAG.x`), but never compare `flags` to a raw preset value.
 */

import type { Archetype, BuildingFeature, RoofShape } from '../../shared/types';
import { ARCHETYPE_ID } from '../../shared/geometry';
import {
  LEGACY_RECIPE_OFFSET,
  SHELL_RECIPE_OFFSET,
  getStyleRecipe,
  packStyleBits,
  shellRecipeForUse,
  type DetailKind,
  type FacadeMotif,
  type StyleProfileName,
  type StyleRecipe,
} from '../../shared/buildingStyles';
import { hexToRgb, pickFacadeColor, pickRoofColor, trimColorFor } from '../../engine/materials/palette';
import { presetForRecipe, recipePresetForId } from '../facades/presets';
import { buildingUseFor, hasStrongStyleEvidence, type BuildingUse } from './buildingUse';
import { noiseFromSeed, seedFromId } from './seed';
import type { RGB, SurfaceStyle, Vec4 } from './meshSink';

export type { RGB, Vec4 };

/** Style data shared by all faces of one building. */
export interface BuildingStyle {
  /** Index of the building in the input array (triangleOwner value). */
  owner: number;
  archetype: Archetype;
  archetypeId: number;
  /** Facade grammar class derived from the payload tags (church, monument, ...). */
  use: BuildingUse;
  floorHeight: number;
  groundFloorHeight: number;
  seed: number;
  /** Packed `aFace.y`: style flag byte + recipe id byte. */
  flags: number;
  /** 0..1 cornice / trim strength hint for the facade shader. */
  trimIntensity: number;
  /** aFace.w detail hint for non-roof faces. */
  detailScale: number;
  /** Emit decorative geometry (ground band split, parapets, ...). */
  detail: boolean;
  /** aStyle vector (archetype id, floor height, ground floor height, seed). */
  style: Vec4;
  /** sRGB facade base colour. */
  baseColor: RGB;
  /** sRGB trim colour (parapet, cornice bands). */
  trimColor: RGB;
  /** Parapet height in metres for flat roofs. */
  parapetHeight: number;
  /** Window bay width of the resolved preset, metres (detail-module rhythm). */
  bayWidth: number;
  /** Cornice band height of the resolved preset, metres. */
  corniceHeight: number;
  /** Resolved style recipe (family or legacy preset). */
  recipe: StyleRecipe;
  /** Reusable geometry modules the recipe allows (safe to attempt, each may skip). */
  detailModules: readonly DetailKind[];
  /** Massing profile the recipe requests. */
  profile: StyleProfileName;
  /** Shader motif family (`legacy` keeps the pre-recipe branches). */
  motif: FacadeMotif;
}

export const SURFACE_DETAIL = {
  /** Default aFace.w multiplier when the caller does not override it. */
  defaultScale: 1,
} as const;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Convert a hex string to sRGB 0..1 (NOT linearised — shader does that). */
export function srgbFromHex(hex: string): RGB {
  const { r, g, b } = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

/** Sanitise the caller supplied detail scale. */
export function sanitiseDetailScale(scale: number | undefined): number {
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return SURFACE_DETAIL.defaultScale;
  return clamp(scale, 0.01, 8);
}

/** Roof base colour for a roof shape, sRGB. */
export function roofColorFor(shape: RoofShape, seed: number): RGB {
  const paletteShape: RoofShape = shape === 'complex' ? 'flat' : shape;
  return srgbFromHex(pickRoofColor(paletteShape, seed));
}

function fract(value: number): number {
  return value - Math.floor(value);
}

/**
 * The GLSL `facadeHash11` function, reproduced on the CPU.
 *
 * Recipe palettes are chosen with this hash of the per-building seed only — no
 * geometry-dependent seeding, so the colour of a building never depends on how
 * its volumes were cut by the tile de-overlap.
 */
export function facadeHash11(p: number): number {
  let x = fract(p * 0.1031);
  x = fract(x * (x + 33.33));
  x = fract(x * (x + x));
  return x;
}

/** Pick a recipe palette colour deterministically from the building seed. */
export function pickRecipeColor(recipe: StyleRecipe, seed: number): string {
  const palette = recipe.palette;
  if (!palette.length) return '#b2bcbf';
  const index = Math.floor(facadeHash11(seed) * palette.length) % palette.length;
  return palette[index];
}

/**
 * Keep the resolved ground/floor band inside the real source height: a modern
 * family's 5.2 m podium must not paint a second storey on a 4 m kiosk.
 */
function clampFacadeMetrics(
  floorHeight: number,
  groundFloorHeight: number,
  height: number,
): { floorHeight: number; groundFloorHeight: number } {
  if (!Number.isFinite(height) || height <= 0) return { floorHeight, groundFloorHeight };
  const safeFloor = clamp(floorHeight, 2.0, Math.max(2.4, height * 0.75));
  const safeGround = clamp(groundFloorHeight, 2.0, Math.max(2.4, Math.min(height * 0.6, 7.5)));
  return { floorHeight: safeFloor, groundFloorHeight: safeGround };
}

/**
 * Uses that must stay plain when the payload carries no explicit height, floor
 * count or building subtype. Anonymous `building=yes` footprints used to borrow
 * massing profiles and pilasters from monumental families.
 */
const PLAIN_USES: ReadonlySet<BuildingUse> = new Set([
  'residential',
  'office',
  'industrial',
  'utility',
]);

/** Detail geometry allowed for a use. Only dispatched modules matter here. */
function detailModulesFor(
  use: BuildingUse,
  recipe: StyleRecipe,
  weakEvidence: boolean,
): readonly DetailKind[] {
  if (weakEvidence) return ['entrance'];
  switch (use) {
    case 'monument':
    case 'roof':
      // Steles, obelisks and roof-only structures: no door, no cornice
      // geometry, no trim.
      return [];
    case 'religious':
    case 'institutional':
    case 'assembly':
      return ['entrance', 'cornice'];
    case 'office':
      return ['entrance', 'canopy', 'cornice'];
    case 'industrial':
    case 'utility':
      return ['entrance'];
    case 'residential': {
      // Keep the family's designed modules; the trim-intensity gate in
      // `facadeDetails` decides whether the monumental ones (piers/plinth) are
      // appropriate for this building.
      const modules: DetailKind[] = [...recipe.details];
      if (!modules.includes('entrance')) modules.unshift('entrance');
      return modules;
    }
    default:
      // Monumental / sport keep the recipe modules; palace and stadium have
      // their own geometry routes.
      return recipe.details;
  }
}

/** The QA gallery renders one fixture per family: it must show the family as designed. */
function isSyntheticGalleryFixture(building: BuildingFeature | null | undefined): boolean {
  return building?.styleVariant?.eligibility?.includes('synthetic_gallery') === true;
}

/** Build the style context for one building. */
export function styleForBuilding(
  building: BuildingFeature,
  owner: number,
  detail: boolean,
  detailScale: number,
): BuildingStyle {
  const archetype: Archetype =
    building && ARCHETYPE_ID[building.archetype] !== undefined ? building.archetype : 'small';
  const seed = seedFromId(building.id ?? `#${owner}`);
  const use = buildingUseFor(building);
  // Curated landmarks keep their data recipe: their bespoke geometry decides
  // where walls, glass and stone go.
  const shell = building?.landmark ? null : shellRecipeForUse(use);
  const recipe = shell ?? getStyleRecipe(building?.styleVariant?.recipeId, archetype);
  const isShell = recipe.id >= SHELL_RECIPE_OFFSET;
  const isLegacy = recipe.id >= LEGACY_RECIPE_OFFSET && !isShell;
  const galleryFixture = isSyntheticGalleryFixture(building);
  const weakEvidence =
    !galleryFixture && !hasStrongStyleEvidence(building) && PLAIN_USES.has(use);
  const preset = isLegacy || isShell
    ? presetForRecipe(recipe)
    : recipePresetForId(recipe.id, archetype);
  // Legacy features keep the exact previous numeric values (byte-compatible
  // facades); modern families are clamped inside the real source height so a
  // 5.2 m podium cannot paint a second storey on a 4 m kiosk.
  const metrics = isLegacy
    ? { floorHeight: preset.floorHeight, groundFloorHeight: preset.groundFloorHeight }
    : clampFacadeMetrics(preset.floorHeight, preset.groundFloorHeight, building?.height ?? 0);
  const baseHex = isLegacy
    ? // Old features keep the exact previous palette pick.
      pickFacadeColor(archetype, seed)
    : pickRecipeColor(recipe, seed);
  const profile: StyleProfileName = weakEvidence ? 'base' : recipe.profile;
  const resolvedRecipe =
    profile === recipe.profile ? recipe : Object.freeze({ ...recipe, profile });
  const style: Vec4 = [
    ARCHETYPE_ID[archetype] ?? ARCHETYPE_ID.small,
    metrics.floorHeight,
    metrics.groundFloorHeight,
    seed,
  ];
  return {
    owner,
    archetype,
    archetypeId: style[0],
    use,
    floorHeight: metrics.floorHeight,
    groundFloorHeight: metrics.groundFloorHeight,
    seed,
    flags: packStyleBits(preset.flags, recipe.id),
    trimIntensity: clamp(preset.corniceHeight / 1.1, 0, 1) * (weakEvidence ? 0.4 : 1),
    detailScale,
    detail,
    style,
    baseColor: srgbFromHex(baseHex),
    trimColor: srgbFromHex(trimColorFor(baseHex)),
    parapetHeight: 0.26 + 0.1 * noiseFromSeed(seed, 3),
    bayWidth: preset.bayWidth,
    corniceHeight: preset.corniceHeight,
    recipe: resolvedRecipe,
    detailModules: galleryFixture ? recipe.details : detailModulesFor(use, resolvedRecipe, weakEvidence),
    profile,
    motif: recipe.facade,
  };
}

/**
 * Style variant for elevated building:part volumes: aStyle.z = -1 tells the
 * facade shader "no ground-floor treatment" so no plinth/shopfront is painted
 * 10 m up on a rooftop part. (Agreed with the facades module.)
 */
export function withNoGroundBand(style: BuildingStyle): BuildingStyle {
  return {
    ...style,
    style: [style.style[0], style.style[1], -1, style.style[3]],
  };
}

/** True when the style carries a recipe detail module (safe to attempt). */
export function hasDetailModule(style: BuildingStyle, kind: DetailKind): boolean {
  return style.detailModules.includes(kind);
}

/** Assemble the complete vertex attribute payload for one surface. */
export function makeSurface(
  style: BuildingStyle,
  kind: number,
  color: RGB,
  detailW: number,
): SurfaceStyle {
  return {
    owner: style.owner,
    color,
    style: style.style,
    face: [kind, style.flags, style.trimIntensity, detailW],
  };
}
