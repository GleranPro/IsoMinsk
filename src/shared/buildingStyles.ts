/**
 * Isometric Minsk — versioned procedural building style registry.
 *
 * One canonical catalog (`building-style-recipes.json`, schema 1) is shared by
 * the TypeScript renderer and the offline Python selector
 * (`scripts/normalize/style_recipes.py`). Family recipe ids are stable `0..26`;
 * ids `27..37` are reserved at runtime for the eleven *legacy* archetype presets
 * so old tile data and protected routes (palace, stadium) reproduce their exact
 * previous facade values instead of borrowing a modern family. Ids `38..40` are
 * renderer-only facade shells (church / monument / assembly hall) chosen from the
 * building use; they are never written to tile data.
 *
 * The registry owns:
 *  - strict, fail-safe recipe lookup (`getStyleRecipe`),
 *  - the float32-safe `aFace.y` bit packing (`flags | recipeId << 8`),
 *  - the complete copy of the eleven prior facade preset values used for legacy
 *    ids (a copy, not an alias into the 27-family table, so a family edit can
 *    never silently move an old building's facade).
 *
 * Contract notes:
 *  - `packStyleBits` refuses recipe ids outside `0..255`; the shader masks the
 *    low byte for flags and clamps the high byte to `0..40`.
 *  - `getStyleRecipe` never returns `undefined`: an unknown or mismatched id
 *    falls back to `legacyRecipeFor(archetype)` and warns once per key.
 */

import { ARCHETYPE_BY_ID, ARCHETYPE_ID, STYLE_FLAG } from './geometry';
import type { Archetype } from './types';
import recipeDocument from './building-style-recipes.json';

/** Massing profile adapter a family may request. */
export type StyleProfileName = 'base' | 'frame' | 'end_pavilion' | 'stepped';

/** Shader motif family; dispatched by one integer derived from recipe metadata. */
export type FacadeMotif =
  | 'monument'
  | 'historic'
  | 'grid'
  | 'loggia'
  | 'balcony_stack'
  | 'staircore'
  | 'ribbon'
  | 'clerestory'
  | 'blank_service'
  | 'assembly_hall'
  // Renderer-only shell motif: tall narrow arched openings (churches).
  | 'church'
  // Legacy presets are not motif families: they keep the pre-recipe shader path.
  | 'legacy';

/** Roof envelope a family may use when the mapped roof is compatible. */
export type RecipeRoofName = 'source' | 'hip' | 'mansard' | 'sawtooth' | 'clerestory';

/** Reusable geometry modules a family may emit (each has a safe skip condition). */
export type DetailKind =
  | 'entrance'
  | 'pilasters'
  | 'cornice'
  | 'parapet'
  | 'balconies'
  | 'loggia'
  | 'rail'
  | 'pavilion'
  | 'stepped'
  | 'canopy'
  | 'roof_service'
  | 'industrial_roof'
  | 'clerestory'
  | 'gable'
  | 'endwall_blank'
  | 'staircore';

export const STYLE_PROFILES: readonly StyleProfileName[] = [
  'base',
  'frame',
  'end_pavilion',
  'stepped',
] as const;

export const FACADE_MOTIFS: readonly FacadeMotif[] = [
  'monument',
  'historic',
  'grid',
  'loggia',
  'balcony_stack',
  'staircore',
  'ribbon',
  'clerestory',
  'blank_service',
  'assembly_hall',
  // Renderer-only shell motif: tall narrow arched openings (churches).
  'church',
] as const;

export const RECIPE_ROOFS: readonly RecipeRoofName[] = [
  'source',
  'hip',
  'mansard',
  'sawtooth',
  'clerestory',
] as const;

export const DETAIL_KINDS: readonly DetailKind[] = [
  'entrance',
  'pilasters',
  'cornice',
  'parapet',
  'balconies',
  'loggia',
  'rail',
  'pavilion',
  'stepped',
  'canopy',
  'roof_service',
  'industrial_roof',
  'clerestory',
  'gable',
  'endwall_blank',
  'staircore',
] as const;

/** One recipe row of the canonical catalog. */
export interface StyleRecipe {
  readonly id: number;
  readonly name: string;
  readonly archetype: Archetype;
  readonly profile: StyleProfileName;
  readonly facade: FacadeMotif;
  readonly roof: RecipeRoofName;
  readonly details: readonly DetailKind[];
  readonly palette: readonly string[];
}

/** Facade numeric parameters of one preset row (mirrors `FacadePreset`). */
export interface RecipeFacadePreset {
  readonly floorHeight: number;
  readonly groundFloorHeight: number;
  readonly bayWidth: number;
  readonly windowWidthRatio: number;
  readonly windowHeightRatio: number;
  readonly sillRatio: number;
  readonly flags: number;
  readonly balconyRatio: number;
  readonly corniceHeight: number;
  readonly colors: readonly string[];
}

/** Number of family recipes (ids 0..26). */
export const FAMILY_RECIPE_COUNT = 27;
/** First runtime recipe id reserved for the legacy archetype presets. */
export const LEGACY_RECIPE_OFFSET = 27;
/** Number of legacy archetype presets (one per archetype). */
export const LEGACY_RECIPE_COUNT = ARCHETYPE_BY_ID.length;
/**
 * First runtime-only "shell" recipe id (renderer facade grammar).
 *
 * Shell rows are not part of the offline catalog: they are chosen at render time
 * from the building use (church / monument / assembly hall) and never appear in
 * tile data. They are appended after the legacy rows so every existing recipe id
 * (families 0..26, legacy 27..37) keeps its meaning.
 */
export const SHELL_RECIPE_OFFSET = LEGACY_RECIPE_OFFSET + LEGACY_RECIPE_COUNT;
/** Number of renderer-only shell recipes. */
export const SHELL_RECIPE_COUNT = 3;
/** Shader uniform rows: 27 families + 11 legacy + 3 shells = 41. */
export const FACADE_PRESET_COUNT =
  FAMILY_RECIPE_COUNT + LEGACY_RECIPE_COUNT + SHELL_RECIPE_COUNT;

const F = STYLE_FLAG;

/**
 * Complete copy of the eleven facade presets as they were before the recipe
 * registry existed (`src/city/facades/presets.ts` at the baseline commit).
 *
 * These values are frozen: legacy tile data and protected routes must reproduce
 * the exact prior facade. `tests/unit/buildings/buildingStyles.test.ts` asserts
 * parity with `FACADE_PRESETS`, so a preset edit fails the build instead of
 * silently changing old buildings.
 */
export const LEGACY_PRESETS: Record<Archetype, RecipeFacadePreset> = {
  stalin: {
    floorHeight: 3.7,
    groundFloorHeight: 4.8,
    bayWidth: 3.7,
    windowWidthRatio: 0.46,
    windowHeightRatio: 0.64,
    sillRatio: 0.16,
    flags: F.monument | F.pilasters | F.cornice | F.shopfront,
    balconyRatio: 0,
    corniceHeight: 1.15,
    colors: ['#c39a63', '#cba66f', '#b98f58', '#d0b078', '#c7a166', '#bd955f'],
  },
  khrushchev: {
    floorHeight: 2.8,
    groundFloorHeight: 2.9,
    bayWidth: 3.2,
    windowWidthRatio: 0.44,
    windowHeightRatio: 0.52,
    sillRatio: 0.22,
    flags: F.balconies | F.cornice,
    balconyRatio: 0.55,
    corniceHeight: 0.35,
    colors: ['#b7bda4', '#c1c7af', '#adb39a', '#a86a52', '#b07a5e', '#b4b9a0'],
  },
  panel: {
    floorHeight: 2.8,
    groundFloorHeight: 3.0,
    bayWidth: 3.4,
    windowWidthRatio: 0.58,
    windowHeightRatio: 0.5,
    sillRatio: 0.24,
    flags: F.balconies | F.cornice,
    balconyRatio: 0.8,
    corniceHeight: 0.3,
    colors: ['#b2bcbf', '#a6b1b5', '#bfc5c5', '#aab5b9', '#9fabb0', '#b8c0c1'],
  },
  modern: {
    floorHeight: 3.2,
    groundFloorHeight: 4.4,
    bayWidth: 4.0,
    windowWidthRatio: 0.7,
    windowHeightRatio: 0.62,
    sillRatio: 0.14,
    flags: F.ribbon | F.shopfront | F.cornice,
    balconyRatio: 0.15,
    corniceHeight: 0.25,
    colors: ['#a7c3c5', '#93b6ba', '#b7cfcd', '#8fb0b3', '#9dbdc0'],
  },
  office: {
    floorHeight: 3.6,
    groundFloorHeight: 4.6,
    bayWidth: 4.2,
    windowWidthRatio: 0.72,
    windowHeightRatio: 0.52,
    sillRatio: 0.2,
    flags: F.ribbon | F.shopfront | F.cornice,
    balconyRatio: 0,
    corniceHeight: 0.3,
    colors: ['#a9b1b3', '#9ba5a9', '#b7bdbb', '#909ba0', '#b3b8b4'],
  },
  historic: {
    floorHeight: 3.4,
    groundFloorHeight: 3.5,
    bayWidth: 3.0,
    windowWidthRatio: 0.38,
    windowHeightRatio: 0.56,
    sillRatio: 0.24,
    flags: F.cornice | F.attic,
    balconyRatio: 0.1,
    corniceHeight: 0.6,
    colors: ['#b98a63', '#c49a76', '#b07a62', '#c9a181', '#b98b76', '#a97a58'],
  },
  industrial: {
    floorHeight: 6.0,
    groundFloorHeight: 6.0,
    bayWidth: 7.5,
    windowWidthRatio: 0.62,
    windowHeightRatio: 0.32,
    sillRatio: 0.52,
    flags: F.ribbon,
    balconyRatio: 0,
    corniceHeight: 0,
    colors: ['#9a9b8e', '#8f9186', '#a4a496', '#95968a'],
  },
  small: {
    floorHeight: 2.8,
    groundFloorHeight: 2.8,
    bayWidth: 3.2,
    windowWidthRatio: 0.32,
    windowHeightRatio: 0.46,
    sillRatio: 0.28,
    flags: 0,
    balconyRatio: 0,
    corniceHeight: 0.18,
    colors: ['#b0a694', '#a89d8a', '#b8ae9c', '#a1968a'],
  },
  civic: {
    floorHeight: 4.4,
    groundFloorHeight: 5.2,
    bayWidth: 3.6,
    windowWidthRatio: 0.4,
    windowHeightRatio: 0.68,
    sillRatio: 0.15,
    flags: F.monument | F.pilasters | F.cornice,
    balconyRatio: 0,
    corniceHeight: 1.0,
    colors: ['#cbc2ad', '#d2ccbb', '#bdb7a6', '#c6beac'],
  },
  palace: {
    floorHeight: 5.0,
    groundFloorHeight: 7.0,
    bayWidth: 7.0,
    windowWidthRatio: 0.55,
    windowHeightRatio: 0.66,
    sillRatio: 0.22,
    flags: F.monument | F.pilasters | F.cornice | F.shopfront | F.attic,
    balconyRatio: 0,
    corniceHeight: 1.4,
    colors: ['#c9b490', '#d2c09e', '#c0aa86', '#ccb996', '#c6b18d', '#c3ae8a'],
  },
  stadium: {
    floorHeight: 6.0,
    groundFloorHeight: 6.0,
    bayWidth: 8.0,
    windowWidthRatio: 0.9,
    windowHeightRatio: 0.2,
    sillRatio: 0.6,
    flags: F.blank | F.ribbon,
    balconyRatio: 0,
    corniceHeight: 0.6,
    colors: ['#9a9e9e', '#8f9393', '#a4a7a6', '#969a99'],
  },
};

/** Raw catalog row shape as it appears in the JSON document. */
interface RawRecipeRow {
  id: number;
  name: string;
  archetype: string;
  profile: string;
  facade: string;
  roof: string;
  details: string[];
  palette: string[];
}

const HEX_COLOR = /^#[0-9a-f]{6}$/;
const RECIPE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Structural validator for the canonical catalog document.
 *
 * Returns a list of human-readable errors (empty = valid). The unit test feeds
 * both the real document and deliberately partial rows, so one empty table row
 * can never silently select a legacy generic in production.
 */
export function validateRecipeCatalog(document: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(document)) return ['catalog must be an array'];
  if (document.length !== FAMILY_RECIPE_COUNT) {
    errors.push(`catalog must contain ${FAMILY_RECIPE_COUNT} recipes, found ${document.length}`);
  }
  const seenIds = new Set<number>();
  const seenNames = new Set<string>();
  document.forEach((row, index) => {
    const label = `row ${index}`;
    if (!row || typeof row !== 'object') {
      errors.push(`${label}: not an object`);
      return;
    }
    const record = row as Partial<RawRecipeRow> & Record<string, unknown>;
    const allowed = new Set([
      'id',
      'name',
      'archetype',
      'profile',
      'facade',
      'roof',
      'details',
      'palette',
    ]);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) errors.push(`${label}: unexpected field "${key}"`);
    }
    if (!Number.isInteger(record.id) || (record.id as number) < 0 || (record.id as number) >= FAMILY_RECIPE_COUNT) {
      errors.push(`${label}: id must be an integer 0..${FAMILY_RECIPE_COUNT - 1}`);
    } else if (seenIds.has(record.id as number)) {
      errors.push(`${label}: duplicate id ${record.id}`);
    } else {
      seenIds.add(record.id as number);
    }
    if (typeof record.name !== 'string' || !RECIPE_NAME.test(record.name)) {
      errors.push(`${label}: name must match ${RECIPE_NAME}`);
    } else if (seenNames.has(record.name)) {
      errors.push(`${label}: duplicate name "${record.name}"`);
    } else {
      seenNames.add(record.name);
    }
    if (typeof record.archetype !== 'string' || !ARCHETYPE_BY_ID.includes(record.archetype as Archetype)) {
      errors.push(`${label}: unsupported archetype "${String(record.archetype)}"`);
    }
    if (!STYLE_PROFILES.includes(record.profile as StyleProfileName)) {
      errors.push(`${label}: unsupported profile "${String(record.profile)}"`);
    }
    if (!FACADE_MOTIFS.includes(record.facade as FacadeMotif)) {
      errors.push(`${label}: unsupported facade "${String(record.facade)}"`);
    }
    if (!RECIPE_ROOFS.includes(record.roof as RecipeRoofName)) {
      errors.push(`${label}: unsupported roof "${String(record.roof)}"`);
    }
    if (!Array.isArray(record.details) || record.details.length === 0) {
      errors.push(`${label}: details must be a non-empty array`);
    } else {
      for (const detail of record.details) {
        if (!DETAIL_KINDS.includes(detail as DetailKind)) {
          errors.push(`${label}: unsupported detail "${String(detail)}"`);
        }
      }
    }
    if (!Array.isArray(record.palette) || record.palette.length !== 3) {
      errors.push(`${label}: palette must contain exactly 3 colours`);
    } else {
      for (const colour of record.palette) {
        if (typeof colour !== 'string' || !HEX_COLOR.test(colour)) {
          errors.push(`${label}: palette colour "${String(colour)}" is not six-digit sRGB`);
        }
      }
    }
  });
  for (let id = 0; id < FAMILY_RECIPE_COUNT; id++) {
    if (!seenIds.has(id)) errors.push(`missing recipe id ${id}`);
  }
  return errors;
}

const catalogErrors = validateRecipeCatalog(recipeDocument);
if (catalogErrors.length > 0 && typeof console !== 'undefined') {
  console.error(`[buildingStyles] invalid recipe catalog:\n${catalogErrors.join('\n')}`);
}

/**
 * The 27 family recipes, in id order, imported verbatim from the canonical JSON.
 * The catalog is validated by `validateRecipeCatalog` (and asserted by the unit
 * test), so the cast cannot hide a structurally broken row.
 */
export const STYLE_RECIPES: readonly StyleRecipe[] = Object.freeze(
  (recipeDocument as unknown as RawRecipeRow[]).map((row) =>
    Object.freeze({
      id: row.id,
      name: row.name,
      archetype: row.archetype as Archetype,
      profile: row.profile as StyleProfileName,
      facade: row.facade as FacadeMotif,
      roof: row.roof as RecipeRoofName,
      details: Object.freeze([...row.details] as DetailKind[]),
      palette: Object.freeze([...row.palette]),
    }),
  ),
);

/**
 * Renderer-only facade shells, in id order (`SHELL_RECIPE_OFFSET..+2`).
 *
 * A shell is a complete recipe row (preset + motif + detail modules) chosen from
 * the building use at render time, so a church does not have to borrow a
 * residential family and a monument does not have to keep a window grid. The
 * offline catalog and the payload are untouched: shells never appear in data.
 */
export const SHELL_RECIPES: readonly StyleRecipe[] = Object.freeze([
  Object.freeze({
    id: SHELL_RECIPE_OFFSET,
    name: 'shell_religious',
    archetype: 'civic' as Archetype,
    profile: 'base' as StyleProfileName,
    facade: 'church' as FacadeMotif,
    roof: 'source' as RecipeRoofName,
    details: Object.freeze(['entrance', 'cornice'] as DetailKind[]),
    palette: Object.freeze(['#d8cbb4', '#cdbfa6', '#e0d5c0']),
  }),
  Object.freeze({
    id: SHELL_RECIPE_OFFSET + 1,
    name: 'shell_monument',
    archetype: 'civic' as Archetype,
    profile: 'base' as StyleProfileName,
    facade: 'monument' as FacadeMotif,
    roof: 'source' as RecipeRoofName,
    details: Object.freeze([] as DetailKind[]),
    palette: Object.freeze(['#8f8b84', '#9a958d', '#85817a']),
  }),
  Object.freeze({
    id: SHELL_RECIPE_OFFSET + 2,
    name: 'shell_assembly',
    archetype: 'civic' as Archetype,
    profile: 'base' as StyleProfileName,
    facade: 'assembly_hall' as FacadeMotif,
    roof: 'source' as RecipeRoofName,
    details: Object.freeze(['entrance', 'cornice'] as DetailKind[]),
    palette: Object.freeze(['#c6beac', '#bdb7a6', '#cbc2ad']),
  }),
]);

/** Shell recipe id for a building use, or null when the use keeps its family. */
export function shellRecipeForUse(use: string): StyleRecipe | null {
  switch (use) {
    case 'religious':
      return SHELL_RECIPES[0] ?? null;
    case 'monument':
    case 'roof':
      // Roof-only structures reuse the blank shell: no windows, no doors.
      return SHELL_RECIPES[1] ?? null;
    case 'assembly':
      return SHELL_RECIPES[2] ?? null;
    default:
      return null;
  }
}

/** Legacy preset recipe id for an archetype (`27 + ARCHETYPE_ID[archetype]`). */
export function legacyRecipeId(archetype: Archetype): number {
  const index = ARCHETYPE_ID[archetype] ?? ARCHETYPE_ID.small;
  return LEGACY_RECIPE_OFFSET + index;
}

/** Complete legacy recipe row for an archetype (same values as before recipes). */
export function legacyRecipeFor(archetype: Archetype): StyleRecipe {
  const safeArchetype: Archetype = ARCHETYPE_ID[archetype] === undefined ? 'small' : archetype;
  const preset = LEGACY_PRESETS[safeArchetype];
  return Object.freeze({
    id: legacyRecipeId(safeArchetype),
    name: `legacy_default_${safeArchetype}`,
    archetype: safeArchetype,
    profile: 'base',
    facade: 'legacy',
    roof: 'source',
    details: Object.freeze([] as DetailKind[]),
    palette: Object.freeze([...preset.colors]),
  });
}

/** Resolve a legacy recipe id (27..37) back to its archetype, or null. */
export function legacyArchetypeForRecipeId(recipeId: number): Archetype | null {
  if (!Number.isInteger(recipeId)) return null;
  const index = recipeId - LEGACY_RECIPE_OFFSET;
  if (index < 0 || index >= ARCHETYPE_BY_ID.length) return null;
  return ARCHETYPE_BY_ID[index];
}

/** Look up a family recipe by exact id, or null outside 0..26. */
export function familyRecipeById(recipeId: number | undefined): StyleRecipe | null {
  if (recipeId === undefined || !Number.isInteger(recipeId)) return null;
  if (recipeId < 0 || recipeId >= FAMILY_RECIPE_COUNT) return null;
  return STYLE_RECIPES[recipeId] ?? null;
}

const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  if (typeof console !== 'undefined') console.warn(message);
}

/**
 * Strict, runtime-safe recipe lookup.
 *
 * - `0..26` resolves a family recipe. When `archetype` is given (the renderer
 *   always passes the source feature's archetype) a family whose broad archetype
 *   disagrees is rejected, warns once and returns the legacy preset; omitting it
 *   is a pure registry lookup used for cross-language parity.
 * - `27..37` resolves the legacy preset row (protected routes and old tiles).
 * - `38..40` resolves a renderer-only shell row (church / monument / assembly).
 * - anything else (missing, negative, NaN, out of range) warns once per key and
 *   returns `legacyRecipeFor(archetype)` — never `undefined`, never id `-1`.
 */
export function getStyleRecipe(id: number | undefined, archetype?: Archetype): StyleRecipe {
  const fallback = legacyRecipeFor(archetype ?? 'panel');
  if (id === undefined) return fallback;
  if (!Number.isInteger(id) || id < 0 || id >= FACADE_PRESET_COUNT) {
    warnOnce(`unknown:${String(id)}:${archetype ?? ''}`, `[buildingStyles] unknown recipe id ${String(id)}; using ${fallback.name}`);
    return fallback;
  }
  if (id >= SHELL_RECIPE_OFFSET) {
    const shell = SHELL_RECIPES[id - SHELL_RECIPE_OFFSET];
    if (!shell) return fallback;
    return shell;
  }
  if (id >= LEGACY_RECIPE_OFFSET) {
    const legacyArchetype = legacyArchetypeForRecipeId(id);
    if (legacyArchetype === null) return fallback;
    return legacyRecipeFor(legacyArchetype);
  }
  const recipe = STYLE_RECIPES[id];
  if (!recipe) {
    warnOnce(`missing:${id}:${archetype ?? ''}`, `[buildingStyles] recipe ${id} missing from catalog; using ${fallback.name}`);
    return fallback;
  }
  if (archetype !== undefined && recipe.archetype !== archetype) {
    warnOnce(
      `mismatch:${id}:${archetype}`,
      `[buildingStyles] recipe ${id} (${recipe.name}) is ${recipe.archetype}, feature is ${archetype}; using ${fallback.name}`,
    );
    return fallback;
  }
  return recipe;
}

/** Numeric shader uniform index for a recipe (0..40), clamped defensively. */
export function facadePresetIndex(recipeId: number): number {
  if (!Number.isFinite(recipeId)) return LEGACY_RECIPE_OFFSET;
  const index = Math.trunc(recipeId);
  if (index < 0) return 0;
  if (index >= FACADE_PRESET_COUNT) return FACADE_PRESET_COUNT - 1;
  return index;
}

/** Recipe id reserved for a motif family; used by geometry dispatch. */
export function motifIndex(recipe: StyleRecipe): number {
  const index = FACADE_MOTIFS.indexOf(recipe.facade);
  return index < 0 ? FACADE_MOTIFS.indexOf('grid') : index;
}

/**
 * Pack the facade style flags and the recipe id into the float32-exact integer
 * stored in `aFace.y`: bits 0..7 = flags, bits 8..15 = recipe id.
 */
export function packStyleBits(flags: number, recipeId: number): number {
  if (!Number.isInteger(recipeId) || recipeId < 0 || recipeId > 255) {
    throw new RangeError('recipeId must be an integer 0..255');
  }
  if (!Number.isInteger(flags)) throw new RangeError('flags must be an integer');
  return ((recipeId << 8) | (flags & 0xff)) >>> 0;
}

/** Unpack `aFace.y` back into the style flag byte and the recipe id byte. */
export function unpackStyleBits(value: number): { flags: number; recipeId: number } {
  const packed = (value | 0) >>> 0;
  return { flags: packed & 0xff, recipeId: (packed >>> 8) & 0xff };
}

/** Test hook: clear the once-per-key warning memory. */
export function resetStyleWarnings(): void {
  warnedKeys.clear();
}
