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
    expect(seasonForDate(new Date('2026-01-10T00:00:00Z'))).toBe('winter');
    expect(seasonForDate(new Date('2026-12-01T00:00:00Z'))).toBe('winter');
  });
});

describe('parseSeason', () => {
  it('accepts the four season names and rejects anything else', () => {
    expect(parseSeason('spring')).toBe('spring');
    expect(parseSeason('summer')).toBe('summer');
    expect(parseSeason('autumn')).toBe('autumn');
    expect(parseSeason('winter')).toBe('winter');
    expect(parseSeason('auto')).toBeNull();
    expect(parseSeason(null)).toBeNull();
  });
});

describe('seasonAppearance', () => {
  it('hides the canopy and sets snow in winter', () => {
    const winter = seasonAppearance('winter');
    expect(winter.canopyVisible).toBe(false);
    expect(winter.snow).toBeGreaterThan(0.5);
  });

  it('recolours spring/autumn canopies and keeps summer stock', () => {
    expect(seasonAppearance('summer').canopyPalette).toBeNull();
    expect(seasonAppearance('autumn').canopyPalette).not.toBeNull();
    expect(seasonAppearance('spring').canopyPalette).not.toBeNull();
    expect(seasonAppearance('autumn').snow).toBe(0);
  });
});
