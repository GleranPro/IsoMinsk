/**
 * Canonical recipe registry contract tests.
 *
 * These guard the cross-language contract: the JSON catalog, the TypeScript
 * registry, the frozen legacy preset copies and the float32-exact `aFace.y`
 * packing. A failure here means the Python selector and the renderer could
 * disagree about a building's style.
 */

import { describe, expect, it } from 'vitest';
import recipeDocument from '../../../src/shared/building-style-recipes.json';
import recipeSchema from '../../../src/shared/building-style-recipes.schema.json';
import {
  DETAIL_KINDS,
  FACADE_MOTIFS,
  FACADE_PRESET_COUNT,
  FAMILY_RECIPE_COUNT,
  LEGACY_PRESETS,
  LEGACY_RECIPE_COUNT,
  LEGACY_RECIPE_OFFSET,
  RECIPE_ROOFS,
  SHELL_RECIPE_COUNT,
  SHELL_RECIPE_OFFSET,
  SHELL_RECIPES,
  STYLE_PROFILES,
  STYLE_RECIPES,
  facadePresetIndex,
  getStyleRecipe,
  legacyArchetypeForRecipeId,
  legacyRecipeFor,
  legacyRecipeId,
  motifIndex,
  packStyleBits,
  resetStyleWarnings,
  unpackStyleBits,
  validateRecipeCatalog,
} from '../../../src/shared/buildingStyles';
import { ARCHETYPE_BY_ID, ARCHETYPE_ID } from '../../../src/shared/geometry';
import { FACADE_PRESETS } from '../../../src/city/facades/presets';
import type { Archetype } from '../../../src/shared/types';

const GENERIC_ARCHETYPES: Archetype[] = [
  'stalin',
  'khrushchev',
  'panel',
  'modern',
  'office',
  'historic',
  'industrial',
  'small',
  'civic',
];

describe('recipe catalog', () => {
  it('exposes the complete stable catalog', () => {
    expect(recipeDocument).toHaveLength(27);
    expect((recipeDocument as Array<{ id: number }>).map((recipe) => recipe.id)).toEqual(
      Array.from({ length: 27 }, (_, id) => id),
    );
    expect(STYLE_RECIPES).toHaveLength(FAMILY_RECIPE_COUNT);
    expect(STYLE_RECIPES.map((recipe) => recipe.id)).toEqual(
      Array.from({ length: FAMILY_RECIPE_COUNT }, (_, id) => id),
    );
    expect(getStyleRecipe(999).name).toBe('legacy_default_panel');
  });

  it('matches the canonical JSON row by row', () => {
    for (const row of recipeDocument as Array<Record<string, unknown>>) {
      const recipe = STYLE_RECIPES[row.id as number];
      expect(recipe.name).toBe(row.name);
      expect(recipe.archetype).toBe(row.archetype);
      expect(recipe.profile).toBe(row.profile);
      expect(recipe.facade).toBe(row.facade);
      expect(recipe.roof).toBe(row.roof);
      expect([...recipe.details]).toEqual(row.details);
      expect([...recipe.palette]).toEqual(row.palette);
    }
  });

  it('validates the shipped catalog with zero errors', () => {
    expect(validateRecipeCatalog(recipeDocument)).toEqual([]);
  });

  it('rejects a partial recipe row instead of silently selecting a generic', () => {
    const broken = JSON.parse(JSON.stringify(recipeDocument)) as Array<Record<string, unknown>>;
    broken[4] = { id: 4, name: 'balcony_slab', archetype: 'khrushchev' };
    const errors = validateRecipeCatalog(broken);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(/profile|facade|roof|details|palette/);
  });

  it('rejects a blank name, a bad palette and an unsupported roof', () => {
    const broken = JSON.parse(JSON.stringify(recipeDocument)) as Array<Record<string, unknown>>;
    broken[0] = {
      ...(broken[0] as Record<string, unknown>),
      name: '',
      palette: ['#c39a63', 'nope', '#d0b078'],
      roof: 'spaceship',
    };
    const errors = validateRecipeCatalog(broken).join('\n');
    expect(errors).toMatch(/name/);
    expect(errors).toMatch(/palette colour/);
    expect(errors).toMatch(/unsupported roof/);
  });

  it('keeps the JSON schema enums in sync with the registry constants', () => {
    const schema = recipeSchema as {
      items: {
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, { enum?: string[] }>;
      };
    };
    expect(schema.items.additionalProperties).toBe(false);
    expect(schema.items.required).toEqual([
      'id',
      'name',
      'archetype',
      'profile',
      'facade',
      'roof',
      'details',
      'palette',
    ]);
    expect(schema.items.properties.profile.enum).toEqual([...STYLE_PROFILES]);
    expect(schema.items.properties.facade.enum).toEqual([...FACADE_MOTIFS]);
    expect(schema.items.properties.roof.enum).toEqual([...RECIPE_ROOFS]);
    const details = schema.items.properties.details as { items: { enum: string[] } };
    expect(details.items.enum).toEqual([...DETAIL_KINDS]);
    expect(schema.items.properties.archetype.enum).toEqual([...ARCHETYPE_BY_ID]);
  });

  it('gives every generic archetype at least three families', () => {
    for (const archetype of GENERIC_ARCHETYPES) {
      const families = STYLE_RECIPES.filter((recipe) => recipe.archetype === archetype);
      expect(families.length).toBeGreaterThanOrEqual(3);
    }
    // Palace and stadium keep dedicated archetypes; no family may claim them.
    expect(STYLE_RECIPES.some((recipe) => recipe.archetype === 'palace')).toBe(false);
    expect(STYLE_RECIPES.some((recipe) => recipe.archetype === 'stadium')).toBe(false);
  });

  it('keeps every palette entry a distinct six-digit sRGB colour family', () => {
    for (const recipe of STYLE_RECIPES) {
      expect(recipe.palette).toHaveLength(3);
      for (const colour of recipe.palette) {
        expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(new Set(recipe.palette).size).toBe(3);
      expect(recipe.details.length).toBeGreaterThan(0);
    }
  });

  it('maps motifs to a stable integer per family', () => {
    const indices = new Set(STYLE_RECIPES.map((recipe) => motifIndex(recipe)));
    expect(indices.size).toBeLessThanOrEqual(FACADE_MOTIFS.length);
    expect(motifIndex(STYLE_RECIPES[0])).toBe(FACADE_MOTIFS.indexOf('monument'));
    expect(motifIndex(STYLE_RECIPES[18])).toBe(FACADE_MOTIFS.indexOf('clerestory'));
    expect(motifIndex(STYLE_RECIPES[26])).toBe(FACADE_MOTIFS.indexOf('assembly_hall'));
  });
});

describe('float32-safe style packing', () => {
  it('keeps flags and recipe ids exact in float32', () => {
    for (const id of [0, 1, 17, 26, 255]) {
      const packed = packStyleBits(0xff, id);
      expect(Math.fround(packed)).toBe(packed);
      expect(unpackStyleBits(packed)).toEqual({ flags: 0xff, recipeId: id });
    }
  });

  it('round-trips every legal preset index with every flag combination', () => {
    for (let recipeId = 0; recipeId < FACADE_PRESET_COUNT; recipeId++) {
      for (const flags of [0x00, 0x01, 0x7f, 0xff]) {
        const packed = packStyleBits(flags, recipeId);
        expect(Number.isInteger(packed)).toBe(true);
        expect(Math.fround(packed)).toBe(packed);
        expect(unpackStyleBits(packed)).toEqual({ flags, recipeId });
      }
    }
  });

  it('refuses recipe ids outside 0..255 and non-integer flags', () => {
    expect(() => packStyleBits(0, -1)).toThrow(RangeError);
    expect(() => packStyleBits(0, 256)).toThrow(RangeError);
    expect(() => packStyleBits(0, 1.5)).toThrow(RangeError);
    expect(() => packStyleBits(0.5, 3)).toThrow(RangeError);
  });

  it('clamps a facade preset index to the legal uniform range', () => {
    expect(facadePresetIndex(-5)).toBe(0);
    expect(facadePresetIndex(0)).toBe(0);
    expect(facadePresetIndex(37)).toBe(37);
    expect(facadePresetIndex(38)).toBe(38);
    expect(facadePresetIndex(FACADE_PRESET_COUNT + 10)).toBe(FACADE_PRESET_COUNT - 1);
    expect(facadePresetIndex(Number.NaN)).toBe(LEGACY_RECIPE_OFFSET);
    expect(facadePresetIndex(Number.POSITIVE_INFINITY)).toBe(LEGACY_RECIPE_OFFSET);
  });
});

describe('legacy fallback', () => {
  it('reserves ids 27..37 for the eleven archetype presets', () => {
    expect(LEGACY_RECIPE_OFFSET).toBe(FAMILY_RECIPE_COUNT);
    expect(LEGACY_RECIPE_COUNT).toBe(ARCHETYPE_BY_ID.length);
    expect(FACADE_PRESET_COUNT).toBe(41);
    expect(SHELL_RECIPE_OFFSET).toBe(38);
    expect(SHELL_RECIPE_COUNT).toBe(3);
    ARCHETYPE_BY_ID.forEach((archetype, index) => {
      expect(legacyRecipeId(archetype)).toBe(27 + index);
      expect(legacyArchetypeForRecipeId(27 + index)).toBe(archetype);
      expect(getStyleRecipe(27 + index).name).toBe(`legacy_default_${archetype}`);
    });
    expect(legacyRecipeId('palace')).toBe(36);
    expect(legacyRecipeId('stadium')).toBe(37);
  });

  it('resolves the renderer-only shells after the legacy range', () => {
    expect(SHELL_RECIPES).toHaveLength(SHELL_RECIPE_COUNT);
    expect(getStyleRecipe(SHELL_RECIPE_OFFSET).name).toBe('shell_religious');
    expect(getStyleRecipe(SHELL_RECIPE_OFFSET).facade).toBe('church');
    expect(getStyleRecipe(SHELL_RECIPE_OFFSET + 1).facade).toBe('monument');
    expect(getStyleRecipe(SHELL_RECIPE_OFFSET + 2).facade).toBe('assembly_hall');
    for (const recipe of SHELL_RECIPES) {
      expect(recipe.id).toBeGreaterThanOrEqual(SHELL_RECIPE_OFFSET);
      expect(recipe.id).toBeLessThan(FACADE_PRESET_COUNT);
    }
  });

  it('reproduces the exact prior facade preset values for every archetype', () => {
    for (const archetype of ARCHETYPE_BY_ID) {
      const preset = FACADE_PRESETS[archetype];
      const legacy = LEGACY_PRESETS[archetype];
      expect(legacy.floorHeight).toBe(preset.floorHeight);
      expect(legacy.groundFloorHeight).toBe(preset.groundFloorHeight);
      expect(legacy.bayWidth).toBe(preset.bayWidth);
      expect(legacy.windowWidthRatio).toBe(preset.windowWidthRatio);
      expect(legacy.windowHeightRatio).toBe(preset.windowHeightRatio);
      expect(legacy.sillRatio).toBe(preset.sillRatio);
      expect(legacy.flags).toBe(preset.flags);
      expect(legacy.balconyRatio).toBe(preset.balconyRatio);
      expect(legacy.corniceHeight).toBe(preset.corniceHeight);
      expect([...legacy.colors]).toEqual([...preset.colors]);
      // The legacy recipe row carries the same palette copy.
      expect([...legacyRecipeFor(archetype).palette]).toEqual([...preset.colors]);
      expect(legacyRecipeFor(archetype).id).toBe(legacyRecipeId(archetype));
    }
  });

  it('falls back to the source archetype for unknown ids and mismatches', () => {
    resetStyleWarnings();
    expect(getStyleRecipe(undefined, 'stalin').name).toBe('legacy_default_stalin');
    expect(getStyleRecipe(-1, 'office').name).toBe('legacy_default_office');
    expect(getStyleRecipe(1.5, 'small').name).toBe('legacy_default_small');
    expect(getStyleRecipe(1000, 'civic').name).toBe('legacy_default_civic');
    // Recipe 6 is a panel family; a khrushchev feature must not borrow it.
    expect(getStyleRecipe(6, 'khrushchev').name).toBe('legacy_default_khrushchev');
    // Matching archetype resolves the family itself.
    expect(getStyleRecipe(6, 'panel').name).toBe('recessed_loggia');
    expect(getStyleRecipe(0, 'stalin').name).toBe('ensemble_symmetric');
  });

  it('never returns an out-of-range or NaN recipe id', () => {
    for (const id of [undefined, -1, 0, 26, 27, 37, 38, 999, Number.NaN]) {
      const recipe = getStyleRecipe(id as number | undefined, 'panel');
      expect(Number.isInteger(recipe.id)).toBe(true);
      expect(recipe.id).toBeGreaterThanOrEqual(0);
      expect(recipe.id).toBeLessThan(FACADE_PRESET_COUNT);
      expect(recipe.name.length).toBeGreaterThan(0);
    }
  });

  it('maps the archetype ids used by aStyle.x exactly as before', () => {
    expect(ARCHETYPE_ID.palace).toBe(9);
    expect(ARCHETYPE_ID.stadium).toBe(10);
    expect(legacyRecipeFor('palace').id).toBe(LEGACY_RECIPE_OFFSET + ARCHETYPE_ID.palace);
    expect(legacyRecipeFor('stadium').id).toBe(LEGACY_RECIPE_OFFSET + ARCHETYPE_ID.stadium);
  });
});
