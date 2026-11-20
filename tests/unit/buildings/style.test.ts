/**
 * Per-building style resolution tests (payload schema 1 recipes).
 *
 * The contract: an old feature (no `styleVariant`) must resolve the legacy
 * archetype preset with its exact previous numeric values and palette, while a
 * family recipe changes the geometry-facing preset and the packed shader index
 * without changing the broad archetype (night lighting and panel/palace
 * semantics stay keyed on the archetype id).
 */

import { describe, expect, it } from 'vitest';
import {
  styleForBuilding,
  facadeHash11,
  pickRecipeColor,
  type BuildingStyle,
} from '../../../src/city/buildings/style';
import { presetFor, presetForRecipe } from '../../../src/city/facades/presets';
import { FACADE_MOTIF_IDS } from '../../../src/engine/shaders/facadeShader';
import {
  LEGACY_RECIPE_OFFSET,
  STYLE_RECIPES,
  getStyleRecipe,
  legacyRecipeId,
  unpackStyleBits,
} from '../../../src/shared/buildingStyles';
import { ARCHETYPE_ID } from '../../../src/shared/geometry';
import { pickFacadeColor } from '../../../src/engine/materials/palette';
import { seedFromId } from '../../../src/city/buildings/seed';
import type { BuildingStyleVariant } from '../../../src/shared/types';
import {
  gabledHistoricBuilding,
  multiVolumeStalinBlock,
  palaceBuilding,
  squarePrismBuilding,
  stadiumBuilding,
} from '../../fixtures/buildings';

function explicitRecipe(recipeId: number): BuildingStyleVariant {
  return { schema: 1, recipeId, source: 'heuristic', eligibility: ['test'] };
}

function resolve(style: BuildingStyle): { flags: number; recipeId: number } {
  return unpackStyleBits(style.flags);
}

describe('legacy resolution', () => {
  it('resolves the previous facade when styleVariant is missing', () => {
    const result = styleForBuilding(squarePrismBuilding(), 0, true, 1);
    expect(result.recipe.name).toBe('legacy_default_panel');
    expect(result.recipe.id).toBe(legacyRecipeId('panel'));
    expect(result.floorHeight).toBe(presetFor('panel').floorHeight);
    expect(result.groundFloorHeight).toBe(presetFor('panel').groundFloorHeight);
    expect(resolve(result)).toEqual({
      flags: presetFor('panel').flags,
      recipeId: LEGACY_RECIPE_OFFSET + ARCHETYPE_ID.panel,
    });
    expect(result.motif).toBe('legacy');
    // The exact previous palette pick, not a recipe palette.
    const seed = seedFromId('w2001');
    expect(result.baseColor).toEqual(
      (() => {
        const { r, g, b } = hexToUnit(pickFacadeColor('panel', seed));
        return [r, g, b];
      })(),
    );
  });

  it('keeps the previous preset for every legacy archetype, including palace and stadium', () => {
    const fixtures = {
      stalin: multiVolumeStalinBlock(),
      palace: palaceBuilding(),
      stadium: stadiumBuilding(),
      historic: gabledHistoricBuilding(),
    } as const;
    for (const [archetype, building] of Object.entries(fixtures)) {
      const style = styleForBuilding(building, 0, true, 1);
      const preset = presetFor(archetype as keyof typeof fixtures);
      expect(style.archetype).toBe(archetype);
      expect(style.floorHeight).toBe(preset.floorHeight);
      expect(style.groundFloorHeight).toBe(preset.groundFloorHeight);
      expect(resolve(style).flags).toBe(preset.flags);
      expect(resolve(style).recipeId).toBe(LEGACY_RECIPE_OFFSET + ARCHETYPE_ID[archetype as keyof typeof fixtures]);
    }
  });

  it('accepts an explicit legacy recipe id (protected routes serialize 27..37)', () => {
    const building = palaceBuilding({
      styleVariant: { schema: 1, recipeId: legacyRecipeId('palace'), source: 'legacy_default', eligibility: ['protected_geometry_route'] },
    });
    const style = styleForBuilding(building, 0, true, 1);
    expect(style.recipe.name).toBe('legacy_default_palace');
    expect(style.motif).toBe('legacy');
    expect(resolve(style).recipeId).toBe(legacyRecipeId('palace'));
  });
});

describe('family recipe resolution', () => {
  it('changes geometry-facing recipe and retains broad archetype for night/panel handling', () => {
    const feature = squarePrismBuilding({
      styleVariant: { schema: 1, recipeId: 8, source: 'heuristic', eligibility: ['levels'] },
    });
    const result = styleForBuilding(feature, 2, true, 1);
    expect(result.archetype).toBe('panel');
    expect(result.archetypeId).toBe(ARCHETYPE_ID.panel);
    expect(result.recipe.name).toBe('staircore_spine');
    expect(unpackStyleBits(result.flags)).toMatchObject({ recipeId: 8 });
    expect(result.motif).toBe('staircore');
    expect(result.profile).toBe('base');
    expect(result.detailModules).toEqual([...getStyleRecipe(8).details]);
  });

  it('uses the recipe preset values and motif flags', () => {
    const feature = squarePrismBuilding({
      styleVariant: explicitRecipe(6), // recessed_loggia (panel)
    });
    const result = styleForBuilding(feature, 0, true, 1);
    const expected = presetForRecipe(STYLE_RECIPES[6]);
    expect(result.recipe.name).toBe('recessed_loggia');
    expect(result.floorHeight).toBe(expected.floorHeight);
    expect(resolve(result).flags).toBe(expected.flags);
    expect(result.motif).toBe('loggia');
  });

  it('picks recipe palette colours deterministically from the seed only', () => {
    const feature = squarePrismBuilding({ styleVariant: explicitRecipe(6) });
    const a = styleForBuilding(feature, 0, true, 1);
    const b = styleForBuilding(feature, 7, false, 0.4);
    expect(a.baseColor).toEqual(b.baseColor);
    const seed = seedFromId(feature.id);
    const expected = pickRecipeColor(STYLE_RECIPES[6], seed);
    expect(STYLE_RECIPES[6].palette).toContain(expected);
    // The hash is the GLSL function, deterministic in [0, 1).
    expect(facadeHash11(seed)).toBeGreaterThanOrEqual(0);
    expect(facadeHash11(seed)).toBeLessThan(1);
    expect(facadeHash11(seed)).toBe(facadeHash11(seed));
  });

  it('falls back to the legacy preset for an out-of-range recipe id', () => {
    for (const recipeId of [-3, 99, 255]) {
      const feature = squarePrismBuilding({ styleVariant: explicitRecipe(recipeId) });
      const style = styleForBuilding(feature, 0, true, 1);
      expect(style.recipe.name).toBe('legacy_default_panel');
      expect(Number.isInteger(style.recipe.id)).toBe(true);
      expect(style.recipe.id).toBeGreaterThanOrEqual(LEGACY_RECIPE_OFFSET);
      expect(style.recipe.id).toBeLessThan(38);
    }
  });

  it('rejects a family whose archetype disagrees with the feature', () => {
    const feature = squarePrismBuilding({ styleVariant: explicitRecipe(0) }); // stalin family
    const style = styleForBuilding(feature, 0, true, 1);
    expect(style.recipe.name).toBe('legacy_default_panel');
    expect(style.archetype).toBe('panel');
  });

  it('clamps family ground/floor bands inside the real source height', () => {
    const short = squarePrismBuilding({
      styleVariant: explicitRecipe(14), // commercial_podium, 5.4 m ground band
    });
    // squarePrismBuilding is 12 m; the podium stays below 60% of that.
    const style = styleForBuilding(short, 0, true, 1);
    expect(style.groundFloorHeight).toBeLessThanOrEqual(12 * 0.6 + 1e-9);
    expect(style.groundFloorHeight).toBeGreaterThanOrEqual(2.0);
  });

  it('maps every family motif to a shader motif id', () => {
    const byName = new Map<string, number>(Object.entries(FACADE_MOTIF_IDS));
    for (const recipe of STYLE_RECIPES) {
      const id = byName.get(recipe.facade);
      expect(id, recipe.name).toBeGreaterThanOrEqual(0);
    }
    expect(byName.get('legacy')).toBe(-1);
  });
});

function hexToUnit(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
  };
}
