/**
 * Facade presets & palette export tests (art direction, no GPU).
 *
 * The presets are a shared contract: the geometry builder reads flags/metrics
 * at build time, the facade shader receives the same metrics as uniforms. These
 * tests pin the invariants both sides rely on.
 */

import { describe, expect, it } from 'vitest';
import {
  FACADE_PRESETS,
  PIXEL_PALETTE,
  PIXEL_PALETTE_SIZE,
  presetFor,
  roofColorFor,
  roofFamilyFor,
  styleFlagsFor,
  trimColor,
} from '../../../src/city/facades/presets';
import { ARCHETYPE_BY_ID, ARCHETYPE_ID, STYLE_FLAG } from '../../../src/shared/geometry';
import type { Archetype } from '../../../src/shared/types';
import { ROOF_COLORS } from '../../../src/engine/materials/palette';
import { isHexColor } from '../../../src/engine/postprocess/palette';

const ARCHETYPES = ARCHETYPE_BY_ID;

describe('FACADE_PRESETS', () => {
  it('covers every archetype exactly once with the matching id', () => {
    expect(ARCHETYPES.length).toBeGreaterThanOrEqual(9);
    expect(ARCHETYPES.length).toBe(Object.keys(ARCHETYPE_ID).length);
    expect(Object.keys(FACADE_PRESETS).sort()).toEqual([...ARCHETYPES].sort());
    for (const archetype of ARCHETYPES) {
      const preset = FACADE_PRESETS[archetype];
      expect(preset.archetype).toBe(archetype);
      expect(preset.id).toBe(ARCHETYPE_ID[archetype]);
    }
  });

  it('keeps storey metrics in the readable pixel-art range', () => {
    for (const archetype of ARCHETYPES) {
      const preset = FACADE_PRESETS[archetype];
      // 2.2..6 m floors: below that windows turn into sub-pixel noise, above it
      // the archetype would no longer be a plausible Minsk building.
      expect(preset.floorHeight).toBeGreaterThanOrEqual(2.2);
      expect(preset.floorHeight).toBeLessThanOrEqual(6);
      // Ground floors can be taller for monumentals (Palace loggia ~7 m).
      expect(preset.groundFloorHeight).toBeGreaterThanOrEqual(2.2);
      expect(preset.groundFloorHeight).toBeLessThanOrEqual(8);
      expect(preset.bayWidth).toBeGreaterThan(1);
      expect(preset.bayWidth).toBeLessThanOrEqual(9);
    }
  });

  it('keeps every ratio a real 0..1 fraction', () => {
    for (const archetype of ARCHETYPES) {
      const preset = FACADE_PRESETS[archetype];
      for (const key of [
        'windowWidthRatio',
        'windowHeightRatio',
        'sillRatio',
        'balconyRatio',
      ] as const) {
        const value = preset[key];
        expect(value, `${archetype}.${key}`).toBeGreaterThanOrEqual(0);
        expect(value, `${archetype}.${key}`).toBeLessThanOrEqual(1);
      }
      // Window must fit inside a storey with the sill below it.
      expect(preset.sillRatio + preset.windowHeightRatio).toBeLessThanOrEqual(1);
      expect(preset.windowWidthRatio).toBeLessThanOrEqual(1);
      expect(preset.corniceHeight).toBeGreaterThanOrEqual(0);
      expect(preset.corniceHeight).toBeLessThan(3);
    }
  });

  it('keeps style flag masks inside the documented 8-bit range', () => {
    for (const archetype of ARCHETYPES) {
      const flags = FACADE_PRESETS[archetype].flags;
      expect(Number.isInteger(flags), `${archetype}.flags`).toBe(true);
      expect(flags).toBeGreaterThanOrEqual(0);
      expect(flags).toBeLessThanOrEqual(255);
      // Every set bit must be one of the documented STYLE_FLAG bits.
      const validMask = Object.values(STYLE_FLAG).reduce((mask, bit) => mask | bit, 0);
      expect(flags & ~validMask).toBe(0);
    }
  });

  it('gives every preset a roof family and a non-empty palette of valid colours', () => {
    for (const archetype of ARCHETYPES) {
      const preset = FACADE_PRESETS[archetype];
      expect(['flat', 'sloped', 'metal']).toContain(preset.roofColorFamily);
      expect(preset.colors.length).toBeGreaterThan(0);
      for (const color of preset.colors) expect(isHexColor(color)).toBe(true);
    }
  });

  it('marks the shopfront archetypes consistently', () => {
    for (const archetype of ['stalin', 'modern', 'office', 'palace'] as Archetype[]) {
      expect(styleFlagsFor(archetype) & STYLE_FLAG.shopfront).not.toBe(0);
    }
    for (const archetype of ['khrushchev', 'panel', 'historic', 'small'] as Archetype[]) {
      expect(styleFlagsFor(archetype) & STYLE_FLAG.shopfront).toBe(0);
    }
  });

  it('has a monumental palace preset (id 9) with colonnade flags', () => {
    const palace = FACADE_PRESETS.palace;
    expect(palace).toBeDefined();
    expect(ARCHETYPE_ID.palace).toBe(9);
    expect(palace.id).toBe(9);
    // Palace of the Republic: long low monumental block, colonnade + loggia.
    expect(palace.floorHeight).toBeGreaterThanOrEqual(4.5);
    expect(palace.floorHeight).toBeLessThanOrEqual(5.5);
    expect(palace.groundFloorHeight).toBeGreaterThanOrEqual(6);
    expect(palace.groundFloorHeight).toBeLessThanOrEqual(8);
    expect(palace.bayWidth).toBeGreaterThanOrEqual(6);
    expect(palace.bayWidth).toBeLessThanOrEqual(8);
    for (const bit of [
      STYLE_FLAG.monument,
      STYLE_FLAG.pilasters,
      STYLE_FLAG.cornice,
      STYLE_FLAG.shopfront,
      STYLE_FLAG.attic,
    ]) {
      expect(palace.flags & bit, `palace missing flag ${bit}`).not.toBe(0);
    }
    expect(palace.corniceHeight).toBeGreaterThanOrEqual(1.2);
    expect(palace.roofColorFamily).toBe('flat');
    expect(palace.colors.length).toBeGreaterThanOrEqual(3);
    expect(styleFlagsFor('palace')).toBe(palace.flags);
  });

  it('has a stadium preset (id 10) with blank concrete walls', () => {
    const stadium = FACADE_PRESETS.stadium;
    expect(stadium).toBeDefined();
    expect(ARCHETYPE_ID.stadium).toBe(10);
    expect(stadium.id).toBe(10);
    expect(stadium.flags & STYLE_FLAG.blank).not.toBe(0);
    expect(stadium.flags & STYLE_FLAG.ribbon).not.toBe(0);
    expect(stadium.roofColorFamily).toBe('flat');
    expect(stadium.colors.length).toBeGreaterThanOrEqual(3);
    expect(styleFlagsFor('stadium')).toBe(stadium.flags);
  });
});

describe('presetFor / styleFlagsFor', () => {
  it('returns the preset for known archetypes', () => {
    for (const archetype of ARCHETYPES) {
      expect(presetFor(archetype)).toBe(FACADE_PRESETS[archetype]);
    }
  });

  it('falls back to the small-building preset for unknown archetypes', () => {
    expect(presetFor('not-an-archetype' as Archetype)).toBe(FACADE_PRESETS.small);
  });

  it('styleFlagsFor mirrors the preset bitmask as an 8-bit integer', () => {
    for (const archetype of ARCHETYPES) {
      const flags = styleFlagsFor(archetype);
      expect(Number.isInteger(flags)).toBe(true);
      expect(flags).toBeGreaterThanOrEqual(0);
      expect(flags).toBeLessThanOrEqual(255);
      expect(flags).toBe(FACADE_PRESETS[archetype].flags);
    }
  });
});

describe('roofColorFor / roofFamilyFor / trimColor', () => {
  it('is deterministic for the same archetype and seed', () => {
    for (const archetype of ARCHETYPES) {
      const first = roofColorFor(archetype, 0.37);
      expect(roofColorFor(archetype, 0.37)).toBe(first);
      expect(isHexColor(first)).toBe(true);
    }
  });

  it('picks from the archetype roof-colour family', () => {
    for (const archetype of ARCHETYPES) {
      const family = roofFamilyFor(archetype);
      expect(['flat', 'sloped', 'metal']).toContain(family);
      const familyColors = ROOF_COLORS[family];
      for (const seed of [0, 0.1, 0.25, 0.5, 0.77, 0.999]) {
        expect(familyColors).toContain(roofColorFor(archetype, seed));
      }
    }
  });

  it('varies with the seed but stays in the family', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) seen.add(roofColorFor('historic', i / 32));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('trimColor returns a valid hex colour', () => {
    for (const archetype of ARCHETYPES) {
      const color = trimColor(archetype, '#b3b6b4');
      expect(isHexColor(color)).toBe(true);
    }
  });
});

describe('PIXEL_PALETTE', () => {
  it('is large enough for a recognisable pixel-art palette', () => {
    expect(PIXEL_PALETTE.length).toBeGreaterThan(12);
    expect(PIXEL_PALETTE_SIZE).toBe(PIXEL_PALETTE.length);
  });

  it('contains only valid, unique hex colours', () => {
    for (const color of PIXEL_PALETTE) expect(isHexColor(color)).toBe(true);
    expect(new Set(PIXEL_PALETTE).size).toBe(PIXEL_PALETTE.length);
  });

  it('covers the full value range needed for readable silhouettes', () => {
    // At least one very dark and one very light entry: pixel-art outlines and
    // night windows depend on both ends of the value range.
    const values = PIXEL_PALETTE.map((hex) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return (r + g + b) / 3;
    });
    expect(Math.min(...values)).toBeLessThan(45);
    expect(Math.max(...values)).toBeGreaterThan(190);
  });
});
