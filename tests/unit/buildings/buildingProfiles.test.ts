/**
 * Bounded massing profile tests.
 *
 * The profile may only redistribute mass inside the declared envelope: every
 * emitted vertex stays inside the source plan (plus the approved 0.45 m
 * projection tolerance), never above the source height, and ineligible
 * topologies (courtyard, concave, explicit parts, small volumes, far level)
 * return the source volumes unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  PROFILE_EPS_M,
  profileVolumes,
  recipeSupportsProfile,
  type GeometryBuildContext,
} from '../../../src/city/buildings/buildingProfiles';
import { buildBuildingsMesh } from '../../../src/city/buildings/buildingsMesh';
import { STYLE_RECIPES, getStyleRecipe } from '../../../src/shared/buildingStyles';
import type { BuildingVolume, Polygon } from '../../../src/shared/types';
import {
  courtyardPolygon,
  decodeMesh,
  lShapedRing,
  makeVolume,
  pointInApprovedPlan,
  rectRing,
  squarePrismBuilding,
  worldBounds,
} from '../../fixtures/buildings';

function contextFor(recipeId: number, overrides: Partial<GeometryBuildContext> = {}): GeometryBuildContext {
  return {
    recipe: getStyleRecipe(recipeId),
    detailLevel: 'near',
    seed: 0.42,
    hasExplicitParts: false,
    ...overrides,
  };
}

function planArea(volume: BuildingVolume): number {
  const ring = volume.footprint[0];
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(area) / 2;
}

describe('profile eligibility', () => {
  it('knows which recipes ask for a massing change', () => {
    expect(recipeSupportsProfile(getStyleRecipe(10))).toBe(true); // stepped_residential
    expect(recipeSupportsProfile(getStyleRecipe(1))).toBe(true); // end_pavilion
    expect(recipeSupportsProfile(getStyleRecipe(6))).toBe(false); // recessed_loggia
    expect(STYLE_RECIPES.filter((recipe) => recipeSupportsProfile(recipe)).length).toBeGreaterThan(1);
  });

  it('keeps the source volumes for far, explicit parts, courtyards, concave rings and small volumes', () => {
    const rectangle = [makeVolume([rectRing(0, 0, 40, 12)], 0, 24, 'flat', 0)];
    const cases: Array<[string, BuildingVolume[], GeometryBuildContext]> = [
      ['far', rectangle, contextFor(10, { detailLevel: 'far' })],
      ['explicit parts', rectangle, contextFor(10, { hasExplicitParts: true })],
      [
        'courtyard',
        [makeVolume(courtyardPolygon(), 0, 24, 'flat', 0)],
        contextFor(10),
      ],
      ['concave', [makeVolume([lShapedRing()], 0, 24, 'flat', 0)], contextFor(10)],
      ['small', [makeVolume([rectRing(0, 0, 8, 6)], 0, 9, 'flat', 0)], contextFor(10)],
      ['base recipe', rectangle, contextFor(6)],
    ];
    for (const [label, volumes, context] of cases) {
      const result = profileVolumes(volumes, context);
      expect(result.changed, label).toBe(false);
      expect(result.volumes).toHaveLength(volumes.length);
      expect(result.profile, label).toBe('base');
    }
  });
});

describe('end pavilion', () => {
  it('keeps the source maximum at one end and lowers the other wing', () => {
    const source = makeVolume([rectRing(0, 0, 48, 14)], 0, 26, 'flat', 0);
    const result = profileVolumes([source], contextFor(1));
    expect(result.changed).toBe(true);
    expect(result.profile).toBe('end_pavilion');
    expect(result.volumes.length).toBe(2);
    const top = Math.max(...result.volumes.map((volume) => volume.height));
    expect(top).toBeCloseTo(source.height, 5);
    const lowered = result.volumes.filter((volume) => volume.height < source.height - 0.4);
    expect(lowered.length).toBe(1);
    // Plan area is conserved by the split.
    const total = result.volumes.reduce((sum, volume) => sum + planArea(volume), 0);
    expect(total).toBeCloseTo(planArea(source), 1);
    for (const volume of result.volumes) {
      expect(volume.height).toBeLessThanOrEqual(source.height + PROFILE_EPS_M);
      expect(volume.minHeight).toBeGreaterThanOrEqual(source.minHeight - 1e-9);
    }
  });

  it('does not invent a sloped roof above the lowered wing', () => {
    const source = makeVolume([rectRing(0, 0, 40, 12)], 0, 18, 'gabled', 4, { roofDirection: 0 });
    const result = profileVolumes([source], contextFor(1));
    expect(result.changed).toBe(true);
    const sloped = result.volumes.filter((volume) => volume.roofShape !== 'flat');
    expect(sloped.length).toBe(1);
    expect(sloped[0].height + sloped[0].roofHeight).toBeLessThanOrEqual(source.height + source.roofHeight + PROFILE_EPS_M);
  });
});

describe('stepped profile', () => {
  it('splits a rectangle at a longitudinal coordinate and caps the step', () => {
    const source = makeVolume([rectRing(0, 0, 56, 16)], 0, 30, 'flat', 0);
    const result = profileVolumes([source], contextFor(10));
    expect(result.changed).toBe(true);
    expect(result.profile).toBe('stepped');
    expect(result.volumes.length).toBe(2);
    const heights = result.volumes.map((volume) => volume.height).sort((a, b) => a - b);
    expect(heights[1]).toBeCloseTo(source.height, 5);
    expect(heights[0]).toBeLessThan(source.height);
    // Both pieces are simple capped prisms with a flat roof.
    for (const volume of result.volumes) {
      expect(volume.roofShape).toBe('flat');
      expect(volume.roofHeight).toBe(0);
      expect(volume.footprint).toHaveLength(1);
    }
  });

  it('is deterministic', () => {
    const source = makeVolume([rectRing(0, 0, 56, 16)], 0, 30, 'flat', 0);
    const a = profileVolumes([source], contextFor(10));
    const b = profileVolumes([source], contextFor(10));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('profiles inside the rendered mesh', () => {
  it('profiles inside the declared height and original footprint', () => {
    const building = squarePrismBuilding({
      id: 'w-profile',
      archetype: 'modern',
      styleVariant: { schema: 1, recipeId: 10, source: 'heuristic', eligibility: ['synthetic_gallery'] },
    });
    // squarePrismBuilding is 10x10 at 12 m: too small for a profile split, so
    // use a large stepped block instead to exercise the real envelope.
    const large = {
      ...building,
      height: 32,
      volumes: [makeVolume([rectRing(0, 0, 60, 16)], 0, 32, 'flat', 0)],
    };
    const result = buildBuildingsMesh([large], { facadeDetail: true, detailScale: 1 });
    const bounds = worldBounds(result.geometry);
    expect(bounds.max[1]).toBeLessThanOrEqual(large.height + 0.05);
    expect(bounds.min[1]).toBeGreaterThanOrEqual(-0.001);
    const positions = result.geometry.getAttribute('position').array as Float32Array;
    for (let i = 0; i < positions.length; i += 3) {
      expect(Number.isFinite(positions[i])).toBe(true); // local east
      expect(positions[i + 1]).toBeLessThanOrEqual(large.height + 0.05);
      expect(Number.isFinite(positions[i + 2])).toBe(true); // world z = -local north
      expect(pointInApprovedPlan(positions[i], -positions[i + 2], large.volumes, 0.45)).toBe(true);
    }
    expect(decodeMesh(result).every((triangle) => Number.isInteger(triangle.owner))).toBe(true);
    expect(result.stats.profiledBuildings).toBe(1);
  });

  it('keeps explicit part / curated stadium signatures unchanged', () => {
    const explicit = squarePrismBuilding({
      id: 'w-parts',
      archetype: 'modern',
      styleVariant: { schema: 1, recipeId: 10, source: 'heuristic', eligibility: ['synthetic_gallery'] },
    });
    explicit.volumes = [
      makeVolume([rectRing(0, 0, 60, 16)], 0, 30, 'flat', 0),
      makeVolume([rectRing(10, 0, 30, 16)], 30, 42, 'flat', 0, { isPart: true }),
    ];
    const result = buildBuildingsMesh([explicit], { facadeDetail: true });
    expect(result.stats.profiledBuildings).toBe(0);
  });

  it('does not add a ground band to an elevated part', () => {
    const elevated = squarePrismBuilding({
      id: 'w-elevated',
      archetype: 'panel',
      styleVariant: { schema: 1, recipeId: 6, source: 'heuristic', eligibility: ['synthetic_gallery'] },
    });
    elevated.volumes = [makeVolume([rectRing(0, 0, 20, 14)], 12, 30, 'flat', 0, { isPart: true })];
    const result = buildBuildingsMesh([elevated], { facadeDetail: true });
    const positions = result.geometry.getAttribute('position').array as Float32Array;
    let minY = Infinity;
    for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, positions[i]);
    expect(minY).toBeGreaterThanOrEqual(11.9);
  });
});
