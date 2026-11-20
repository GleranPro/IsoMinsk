import { describe, expect, it } from 'vitest';

import {
  parseSeason,
  seasonAppearance,
  seasonForDate,
} from '../../../src/engine/renderer/seasons';

describe('seasonForDate', () => {
  it('maps months to meteorological seasons (northern hemisphere)', () => {
    expect(seasonForDate(new Date('2026-03-15T00:00:00Z'))).toBe('spring');
    expect(seasonForDate(new Date('2026-06-21T00:00:00Z'))).toBe('summer');
    expect(seasonForDate(new Date('2026-10-30T00:00:00Z'))).toBe('autumn');
    // Winter is intentionally absent: cold months fall back to autumn until a
    // designed winter ships (owner decision, 2026-11-20).
    expect(seasonForDate(new Date('2026-01-10T00:00:00Z'))).toBe('autumn');
    expect(seasonForDate(new Date('2026-12-01T00:00:00Z'))).toBe('autumn');
  });
});

describe('parseSeason', () => {
  it('accepts the three season names and rejects anything else', () => {
    expect(parseSeason('spring')).toBe('spring');
    expect(parseSeason('summer')).toBe('summer');
    expect(parseSeason('autumn')).toBe('autumn');
    expect(parseSeason('winter')).toBeNull();
    expect(parseSeason('auto')).toBeNull();
    expect(parseSeason(null)).toBeNull();
  });
});

describe('seasonAppearance', () => {
  it('gives every season an explicit palette (switching summer->autumn->summer works)', () => {
    for (const season of ['spring', 'summer', 'autumn'] as const) {
      expect(seasonAppearance(season).canopyPalette).toHaveLength(4);
    }
    // Summer restores the baseline canopy, not the previous season's colours.
    expect(seasonAppearance('summer').canopyPalette).toEqual(['#52783c', '#648749', '#73944f', '#456b36']);
  });

  it('keeps spring visibly lighter than summer (fresh foliage)', () => {
    const spring = seasonAppearance('spring').canopyPalette;
    const summer = seasonAppearance('summer').canopyPalette;
    expect(spring).not.toEqual(summer);
    // Spring's first swatch is markedly lighter than summer's deepest green.
    const lightness = (hex: string): number => {
      const value = parseInt(hex.slice(1), 16);
      return ((value >> 16) & 0xff) + ((value >> 8) & 0xff) + (value & 0xff);
    };
    expect(Math.min(...spring.map(lightness))).toBeGreaterThan(
      Math.min(...summer.map(lightness)) + 60,
    );
  });
});
