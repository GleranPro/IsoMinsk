/**
 * Isometric Minsk — architectural facade presets.
 *
 * One preset per archetype drives both the facade shader (window metrics,
 * decoration) and the geometry builder (which style flags it writes into the
 * vertex attributes). Owned by the facades / art-direction module.
 *
 * All dimensions are metres unless stated otherwise; ratios are 0..1 of the
 * storey height or of the window bay width.
 *
 * Art-direction notes (target: 320-420 px tall internal render):
 *  - Bay widths stay inside 2.8-4.2 m so that at 3-5 px/m (street-level zoom) a
 *    window is 6-14 px wide and the punched-window rhythm stays legible.
 *  - At overview zoom (≈0.5 px/m, a 3 m bay is ~1.5 px) the shader switches to
 *    an averaged tone per bay/floor, so presets are tuned for both scales:
 *    window ratios are high enough (~0.44-0.72 of the bay) that the average
 *    reads as "glazed" rather than "blank concrete".
 *  - Stalinist ensembles: bigger bays, taller floors, stronger cornice, warm
 *    plaster. Khrushchev: small windows, sparse ornament. Panel: wide bays,
 *    monotonous balconies, cool concrete. Modern/office: ribbon glazing.
 *  - Historic: narrow bays, tall thin windows, pitched roofs, mansard attic.
 */

import type { Archetype } from '../../shared/types';
import { ARCHETYPE_BY_ID, ARCHETYPE_ID, STYLE_FLAG } from '../../shared/geometry';
import {
  FACADE_MOTIFS,
  FACADE_PRESET_COUNT,
  FAMILY_RECIPE_COUNT,
  LEGACY_RECIPE_OFFSET,
  STYLE_RECIPES,
  legacyRecipeFor,
  type FacadeMotif,
  type StyleRecipe,
} from '../../shared/buildingStyles';
import { ARCHETYPE_COLORS, ROOF_COLORS, trimColorFor } from '../../engine/materials/palette';

export interface FacadePreset {
  archetype: Archetype;
  /** Integer id written into aStyle.x. */
  id: number;
  /** Default storey height when the data does not specify one. */
  floorHeight: number;
  /** Ground floor height (shops / taller lobbies). */
  groundFloorHeight: number;
  /** Window bay width: distance between window centres. */
  bayWidth: number;
  /** Window width as a fraction of bayWidth. */
  windowWidthRatio: number;
  /** Window height as a fraction of the storey height. */
  windowHeightRatio: number;
  /** Sill height above the floor slab, as a fraction of floorHeight. */
  sillRatio: number;
  /** Style flags bitmask (see STYLE_FLAG). */
  flags: number;
  /** Cornice band height, metres (0 = none). */
  corniceHeight: number;
  /** Fraction of floors that carry balcony bands (0 = none). */
  balconyRatio: number;
  /** Roof colour family used by the geometry builder. */
  roofColorFamily: 'flat' | 'sloped' | 'metal';
  /** Facade colours to pick from. */
  colors: readonly string[];
}

const F = STYLE_FLAG;

export const FACADE_PRESETS: Record<Archetype, FacadePreset> = {
  // Soviet neoclassical / Stalinist ensembles along Independence Avenue:
  // monumental bays, pilasters, strong cornice, tall ground floor with shops.
  stalin: {
    archetype: 'stalin',
    id: ARCHETYPE_ID.stalin,
    floorHeight: 3.7,
    groundFloorHeight: 4.8,
    bayWidth: 3.7,
    windowWidthRatio: 0.46,
    windowHeightRatio: 0.64,
    sillRatio: 0.16,
    flags: F.monument | F.pilasters | F.cornice | F.shopfront,
    corniceHeight: 1.15,
    balconyRatio: 0,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.stalin,
  },
  // Khrushchev-era 5-storey blocks: small punched windows, sparse decoration,
  // freestanding balconies on some bays.
  khrushchev: {
    archetype: 'khrushchev',
    id: ARCHETYPE_ID.khrushchev,
    floorHeight: 2.8,
    groundFloorHeight: 2.9,
    bayWidth: 3.2,
    windowWidthRatio: 0.44,
    windowHeightRatio: 0.52,
    sillRatio: 0.22,
    flags: F.balconies | F.cornice,
    corniceHeight: 0.35,
    balconyRatio: 0.55,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.khrushchev,
  },
  // Brezhnev-era 9-12 storey panel blocks: wide bays, continuous balcony bands,
  // deliberately repetitive and cooler than the plaster ensembles.
  panel: {
    archetype: 'panel',
    id: ARCHETYPE_ID.panel,
    floorHeight: 2.8,
    groundFloorHeight: 3.0,
    bayWidth: 3.4,
    windowWidthRatio: 0.58,
    windowHeightRatio: 0.50,
    sillRatio: 0.24,
    flags: F.balconies | F.cornice,
    corniceHeight: 0.30,
    balconyRatio: 0.8,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.panel,
  },
  // Modern apartment towers: glazed bands, vertical accents, tall lobby.
  modern: {
    archetype: 'modern',
    id: ARCHETYPE_ID.modern,
    floorHeight: 3.2,
    groundFloorHeight: 4.4,
    bayWidth: 4.0,
    windowWidthRatio: 0.70,
    windowHeightRatio: 0.62,
    sillRatio: 0.14,
    flags: F.ribbon | F.shopfront | F.cornice,
    corniceHeight: 0.25,
    balconyRatio: 0.15,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.modern,
  },
  // Standard offices and commercial: ribbon windows, shopfronts, heavy base.
  office: {
    archetype: 'office',
    id: ARCHETYPE_ID.office,
    floorHeight: 3.6,
    groundFloorHeight: 4.6,
    bayWidth: 4.2,
    windowWidthRatio: 0.72,
    windowHeightRatio: 0.52,
    sillRatio: 0.20,
    flags: F.ribbon | F.shopfront | F.cornice,
    corniceHeight: 0.30,
    balconyRatio: 0,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.office,
  },
  // Pre-war low-rise: small punched windows, plastered walls, pitched roofs,
  // a mansard-ish attic band above the cornice.
  historic: {
    archetype: 'historic',
    id: ARCHETYPE_ID.historic,
    floorHeight: 3.4,
    groundFloorHeight: 3.5,
    bayWidth: 3.0,
    windowWidthRatio: 0.38,
    windowHeightRatio: 0.56,
    sillRatio: 0.24,
    flags: F.cornice | F.attic,
    corniceHeight: 0.60,
    balconyRatio: 0.10,
    roofColorFamily: 'sloped',
    colors: ARCHETYPE_COLORS.historic,
  },
  // Industrial sheds / depots: very wide structural bays, high clerestory
  // ribbon glazing, metal roofs. The 'blank' style is supported by the shader
  // but the pilot area's sheds get high glazing instead of blank walls.
  industrial: {
    archetype: 'industrial',
    id: ARCHETYPE_ID.industrial,
    floorHeight: 6.0,
    groundFloorHeight: 6.0,
    bayWidth: 7.5,
    windowWidthRatio: 0.62,
    windowHeightRatio: 0.32,
    sillRatio: 0.52,
    flags: F.ribbon,
    corniceHeight: 0,
    balconyRatio: 0,
    roofColorFamily: 'metal',
    colors: ARCHETYPE_COLORS.industrial,
  },
  // Garages, kiosks, outbuildings: tiny punched windows, low sawn roofs.
  small: {
    archetype: 'small',
    id: ARCHETYPE_ID.small,
    floorHeight: 2.8,
    groundFloorHeight: 2.8,
    bayWidth: 3.2,
    windowWidthRatio: 0.32,
    windowHeightRatio: 0.46,
    sillRatio: 0.28,
    flags: 0,
    corniceHeight: 0.18,
    balconyRatio: 0,
    roofColorFamily: 'sloped',
    colors: ARCHETYPE_COLORS.small,
  },
  // Public / cultural / religious buildings: tall bays, strong cornice, stone.
  civic: {
    archetype: 'civic',
    id: ARCHETYPE_ID.civic,
    floorHeight: 4.4,
    groundFloorHeight: 5.2,
    bayWidth: 3.6,
    windowWidthRatio: 0.40,
    windowHeightRatio: 0.68,
    sillRatio: 0.15,
    flags: F.monument | F.pilasters | F.cornice,
    corniceHeight: 1.0,
    balconyRatio: 0,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.civic,
  },
  // Monumental civic ensembles (Palace of the Republic): long, low, very wide
  // block; a colonnade-like pilaster rhythm with two tall windows per bay, a
  // tall glazed loggia ground floor and a strong double-line cornice/attic.
  // floorHeight ~5 m, ground floor ~7 m, 7 m bays between pilasters.
  palace: {
    archetype: 'palace',
    id: ARCHETYPE_ID.palace,
    floorHeight: 5.0,
    groundFloorHeight: 7.0,
    bayWidth: 7.0,
    // Fraction of one half-bay (windows come in pairs between pilasters).
    windowWidthRatio: 0.55,
    windowHeightRatio: 0.66,
    sillRatio: 0.22,
    flags: F.monument | F.pilasters | F.cornice | F.shopfront | F.attic,
    corniceHeight: 1.4,
    balconyRatio: 0,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.palace,
  },
  // Sports arenas / grandstands: blank concrete bowl walls with only a sparse
  // horizontal glazing band. The geometry builder emits STYLE_FLAG.blank for
  // stadium stands, so this is mostly a fallback/material identity preset.
  stadium: {
    archetype: 'stadium',
    id: ARCHETYPE_ID.stadium,
    floorHeight: 6.0,
    groundFloorHeight: 6.0,
    bayWidth: 8.0,
    windowWidthRatio: 0.9,
    windowHeightRatio: 0.2,
    sillRatio: 0.6,
    flags: F.blank | F.ribbon,
    corniceHeight: 0.6,
    balconyRatio: 0,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.stadium,
  },
};

export function presetFor(archetype: Archetype): FacadePreset {
  return FACADE_PRESETS[archetype] ?? FACADE_PRESETS.small;
}

/** Style flag bitmask for the shader. */
export function styleFlagsFor(archetype: Archetype): number {
  return presetFor(archetype).flags;
}

/** Trim / cornice colour for an archetype base colour. */
export function trimColor(archetype: Archetype, baseColor: string): string {
  return trimColorFor(baseColor);
}

/** Roof colour family for an archetype. */
export function roofFamilyFor(archetype: Archetype): 'flat' | 'sloped' | 'metal' {
  return presetFor(archetype).roofColorFamily;
}

/** Pick a roof colour honouring the archetype family (deterministic by seed). */
export function roofColorFor(archetype: Archetype, seed: number): string {
  const family = roofFamilyFor(archetype);
  const colors =
    family === 'flat' ? ROOF_COLORS.flat : family === 'metal' ? ROOF_COLORS.metal : ROOF_COLORS.sloped;
  const index = Math.floor(fract(Math.abs(Math.sin((seed + 0.13) * 91.13)) * 1000) * colors.length) % colors.length;
  return colors[index];
}

/**
 * Palette used by the pixel-art colour quantisation pass. Canonical definition
 * lives in src/engine/postprocess/palette.ts (shared with the facade material
 * and imported by the renderer's post-processing pass); re-exported here for
 * historical imports.
 */
export { PIXEL_PALETTE, PIXEL_PALETTE_SIZE } from '../../engine/postprocess/palette';

// ---------------------------------------------------------------------------
// Recipe-driven facade parameters (payload schema 1)
// ---------------------------------------------------------------------------

/**
 * Numeric facade parameters of one preset row, resolved for a recipe.
 *
 * Rows `0..26` come from the family catalog; rows `27..37` are the frozen legacy
 * archetype presets. The shader indexes `uPresetA/B` with the packed recipe id,
 * so a legacy building keeps exactly the values it had before the registry.
 */
export interface RecipePreset extends FacadePreset {
  /** Uniform row index (0..37). */
  recipeId: number;
  /** Shader motif family; `legacy` keeps the pre-recipe branches. */
  motif: FacadeMotif;
}

interface FamilyPresetOverride {
  floorHeight?: number;
  groundFloorHeight?: number;
  bayWidth?: number;
  windowWidthRatio?: number;
  windowHeightRatio?: number;
  sillRatio?: number;
  balconyRatio?: number;
  corniceHeight?: number;
}

/**
 * Per-family facade rhythm. Only the values that differ from the broad archetype
 * preset are listed; the motif then adjusts the style flags. Every entry is a
 * coordinated set (bay + window + cornice + ground band), never a random tweak.
 */
const FAMILY_PRESET_OVERRIDES: Record<string, FamilyPresetOverride> = {
  ensemble_symmetric: { floorHeight: 3.7, groundFloorHeight: 5.0, bayWidth: 3.9, windowWidthRatio: 0.46, corniceHeight: 1.25 },
  end_pavilion: { bayWidth: 3.6, windowWidthRatio: 0.44, corniceHeight: 1.1 },
  restrained_monument: { bayWidth: 3.5, windowWidthRatio: 0.4, windowHeightRatio: 0.58, corniceHeight: 0.7 },
  brick_punched: { bayWidth: 3.0, windowWidthRatio: 0.38, windowHeightRatio: 0.48, sillRatio: 0.24, balconyRatio: 0.25 },
  balcony_slab: { bayWidth: 3.3, windowWidthRatio: 0.46, balconyRatio: 0.9, corniceHeight: 0.3 },
  pitched_low_block: { bayWidth: 3.3, windowWidthRatio: 0.42, corniceHeight: 0.25 },
  recessed_loggia: { bayWidth: 3.6, windowWidthRatio: 0.62, windowHeightRatio: 0.54, balconyRatio: 0.95, corniceHeight: 0.25 },
  endwall_tower: { bayWidth: 3.2, windowWidthRatio: 0.55, windowHeightRatio: 0.5 },
  staircore_spine: { bayWidth: 3.4, windowWidthRatio: 0.5, windowHeightRatio: 0.52, balconyRatio: 0 },
  podium_tower: { floorHeight: 3.3, groundFloorHeight: 5.2, bayWidth: 4.2, windowWidthRatio: 0.74, balconyRatio: 0.1 },
  stepped_residential: { bayWidth: 4.0, windowWidthRatio: 0.66, balconyRatio: 0.5 },
  framed_residential: { bayWidth: 4.0, windowWidthRatio: 0.6, windowHeightRatio: 0.58, balconyRatio: 0.3 },
  curtain_ribbon: { bayWidth: 3.9, windowWidthRatio: 0.8, windowHeightRatio: 0.58 },
  framed_stone_grid: { groundFloorHeight: 5.0, bayWidth: 4.0, windowWidthRatio: 0.55, windowHeightRatio: 0.5 },
  commercial_podium: { groundFloorHeight: 5.4, bayWidth: 4.4, windowWidthRatio: 0.76 },
  plaster_street_house: { bayWidth: 3.0, windowWidthRatio: 0.38, windowHeightRatio: 0.58, corniceHeight: 0.7 },
  brick_gabled_house: { bayWidth: 3.1, windowWidthRatio: 0.34, windowHeightRatio: 0.62, corniceHeight: 0.45 },
  mansard_attic: { floorHeight: 3.2, bayWidth: 3.0, windowWidthRatio: 0.36, corniceHeight: 0.5 },
  sawtooth_factory: { floorHeight: 6.5, bayWidth: 7.5, windowWidthRatio: 0.6, windowHeightRatio: 0.26, sillRatio: 0.6 },
  broad_clerestory_hall: { floorHeight: 7.0, bayWidth: 8.5, windowWidthRatio: 0.64, windowHeightRatio: 0.22, sillRatio: 0.66 },
  service_workshop: { floorHeight: 4.6, groundFloorHeight: 4.6, bayWidth: 6.0, windowWidthRatio: 0.4, windowHeightRatio: 0.28 },
  hipped_house: { floorHeight: 2.9, bayWidth: 3.2, windowWidthRatio: 0.34, windowHeightRatio: 0.48, corniceHeight: 0.22 },
  flat_service_annex: { floorHeight: 3.0, bayWidth: 4.0, windowWidthRatio: 0.24, windowHeightRatio: 0.34, corniceHeight: 0.12 },
  gabled_workshop: { floorHeight: 3.0, bayWidth: 3.6, windowWidthRatio: 0.3, windowHeightRatio: 0.4, corniceHeight: 0.15 },
  school_hospital_wings: { floorHeight: 4.0, bayWidth: 3.4, windowWidthRatio: 0.42, windowHeightRatio: 0.64 },
  public_colonnade: { floorHeight: 4.6, bayWidth: 3.8, windowWidthRatio: 0.4, corniceHeight: 1.15 },
  assembly_hall: { floorHeight: 6.0, groundFloorHeight: 6.0, bayWidth: 6.5, windowWidthRatio: 0.5, windowHeightRatio: 0.24, sillRatio: 0.6 },
};

/** Style flags forced by a motif family (applied after the archetype flags). */
const MOTIF_FLAG_ADD: Record<FacadeMotif, number> = {
  monument: F.monument | F.pilasters | F.cornice,
  historic: F.cornice,
  grid: F.pilasters | F.cornice,
  loggia: F.balconies | F.cornice,
  balcony_stack: F.balconies | F.cornice,
  staircore: F.cornice,
  ribbon: F.ribbon | F.cornice,
  clerestory: F.ribbon,
  blank_service: 0,
  assembly_hall: F.ribbon | F.cornice,
  legacy: 0,
};

/** Style flags a motif family removes from the archetype flags. */
const MOTIF_FLAG_REMOVE: Record<FacadeMotif, number> = {
  monument: 0,
  historic: F.balconies,
  grid: F.balconies,
  loggia: F.ribbon,
  balcony_stack: F.ribbon,
  staircore: F.balconies | F.ribbon,
  ribbon: F.balconies,
  clerestory: F.balconies | F.monument | F.pilasters | F.attic,
  blank_service:
    F.balconies | F.ribbon | F.monument | F.pilasters | F.attic | F.shopfront | F.cornice,
  assembly_hall: F.balconies | F.monument | F.pilasters,
  legacy: 0,
};

/** Resolve the complete numeric preset for one recipe (family or legacy). */
export function presetForRecipe(recipe: StyleRecipe): RecipePreset {
  if (recipe.id >= LEGACY_RECIPE_OFFSET) {
    const legacy = FACADE_PRESETS[recipe.archetype];
    return { ...legacy, recipeId: recipe.id, motif: 'legacy' };
  }
  const base = FACADE_PRESETS[recipe.archetype];
  const override = FAMILY_PRESET_OVERRIDES[recipe.name] ?? {};
  const motif = recipe.facade;
  const flags =
    (base.flags | MOTIF_FLAG_ADD[motif]) & ~MOTIF_FLAG_REMOVE[motif] & 0xff;
  const groundFloorHeight = override.groundFloorHeight ?? base.groundFloorHeight;
  // Motifs that own the ground floor (shopfront/entrance rhythms) keep a tall
  // ground band; the rest stay within a normal storey so the shader cannot paint
  // a shopfront on a small service building.
  const wantsShopfront = (flags & F.shopfront) !== 0;
  return {
    ...base,
    floorHeight: override.floorHeight ?? base.floorHeight,
    groundFloorHeight,
    bayWidth: override.bayWidth ?? base.bayWidth,
    windowWidthRatio: override.windowWidthRatio ?? base.windowWidthRatio,
    windowHeightRatio: override.windowHeightRatio ?? base.windowHeightRatio,
    sillRatio: override.sillRatio ?? base.sillRatio,
    balconyRatio: override.balconyRatio ?? base.balconyRatio,
    corniceHeight: override.corniceHeight ?? base.corniceHeight,
    flags: wantsShopfront ? flags | F.shopfront : flags & ~F.shopfront,
    colors: recipe.palette,
    recipeId: recipe.id,
    motif,
  };
}

/**
 * The 38 shader preset rows in uniform order: family recipes `0..26` first, then
 * the frozen legacy archetype presets `27..37`.
 */
export function presetRowsForUniforms(): RecipePreset[] {
  const rows: RecipePreset[] = [];
  for (let id = 0; id < FAMILY_RECIPE_COUNT; id++) {
    rows.push(presetForRecipe(STYLE_RECIPES[id]));
  }
  for (const archetype of ARCHETYPE_BY_ID) {
    rows.push(presetForRecipe(legacyRecipeFor(archetype)));
  }
  if (rows.length !== FACADE_PRESET_COUNT) {
    throw new Error(`facade preset rows ${rows.length} != ${FACADE_PRESET_COUNT}`);
  }
  return rows;
}

/**
 * Per-row motif id uploaded to the shader (`-1` = legacy archetype preset).
 * The shader branches on this small integer instead of on 27 recipe names.
 */
export function motifRowsForUniforms(): Float32Array {
  const rows = new Float32Array(FACADE_PRESET_COUNT);
  rows.fill(-1);
  for (let id = 0; id < FAMILY_RECIPE_COUNT; id++) {
    rows[id] = FACADE_MOTIFS.indexOf(STYLE_RECIPES[id].facade);
  }
  return rows;
}

/** Recipe preset for a packed recipe id, with the legacy fallback. */
export function recipePresetForId(recipeId: number, archetype: Archetype): RecipePreset {
  const index = Number.isInteger(recipeId) ? recipeId : LEGACY_RECIPE_OFFSET;
  const recipe =
    index >= 0 && index < FAMILY_RECIPE_COUNT
      ? STYLE_RECIPES[index]
      : legacyRecipeFor(archetype);
  return presetForRecipe(recipe);
}

function fract(value: number): number {
  return value - Math.floor(value);
}
