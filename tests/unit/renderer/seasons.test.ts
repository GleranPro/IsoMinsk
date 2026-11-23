import { describe, expect, it } from 'vitest';

import {
  parseSeason,
  seasonAppearance,
  seasonAutumnMix,
  seasonForDate,
  seasonMembershipSum,
  seasonWeights,
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

describe('seasonWeights', () => {
  const at = (iso: string) => seasonWeights(new Date(iso));
  it('pins the documented autumn ramp on concrete dates', () => {
    // 1 September starts from zero; month ends land on the plan's endpoints.
    expect(at('2026-09-01T00:00:00Z').autumnMix).toBeCloseTo(0, 5);
    expect(at('2026-10-01T00:00:00Z').autumnMix).toBeCloseTo(0.4, 5);
    expect(at('2026-11-01T00:00:00Z').autumnMix).toBeCloseTo(0.9, 5);
    expect(at('2026-11-30T23:59:59Z').autumnMix).toBeCloseTo(1, 3);
    expect(at('2026-10-15T12:00:00Z').autumnMix).toBeGreaterThan(0.4);
    expect(at('2026-10-15T12:00:00Z').autumnMix).toBeLessThan(0.9);
  });

  it('pins the documented winter ramp: late arrival, January peak, March melt', () => {
    for (const iso of ['2026-06-21T00:00:00Z', '2026-09-15T00:00:00Z', '2026-11-30T23:59:59Z']) {
      expect(at(iso).winterMix).toBe(0);
    }
    expect(at('2026-12-01T00:00:00Z').winterMix).toBeCloseTo(0, 5);
    expect(at('2027-01-01T00:00:00Z').winterMix).toBeCloseTo(0.7, 5);
    expect(at('2027-01-31T23:59:59Z').winterMix).toBeCloseTo(1, 3);
    expect(at('2027-02-01T00:00:00Z').winterMix).toBeCloseTo(1, 5);
    expect(at('2027-02-28T23:59:59Z').winterMix).toBeCloseTo(0.8, 3);
    // Spring melt continues through March, so late March has less cover.
    expect(at('2027-03-15T00:00:00Z').winterMix).toBeGreaterThan(0);
    expect(at('2027-03-15T00:00:00Z').winterMix).toBeLessThan(0.8);
    expect(at('2027-03-31T23:59:59Z').winterMix).toBeCloseTo(0, 3);
  });

  it('cross-fades season membership instead of switching on a date boundary', () => {
    // December starts as autumn and hands over to winter over ~18 days.
    const dec1 = at('2026-12-01T00:00:00Z');
    expect(dec1.autumn).toBeGreaterThan(0.9);
    expect(dec1.winter).toBeLessThan(0.1);
    const dec20 = at('2026-12-20T00:00:00Z');
    expect(dec20.winter).toBeCloseTo(1, 5);
    expect(dec20.autumn).toBeCloseTo(0, 5);
    // March starts as winter and becomes spring.
    expect(at('2027-03-01T00:00:00Z').winter).toBeGreaterThan(0.9);
    expect(at('2027-03-20T00:00:00Z').spring).toBeCloseTo(1, 5);
    // Mid-season dates are unambiguous.
    expect(at('2027-01-15T00:00:00Z').winter).toBeCloseTo(1, 5);
    expect(at('2026-07-15T00:00:00Z').summer).toBeCloseTo(1, 5);
    expect(at('2026-04-15T00:00:00Z').spring).toBeCloseTo(1, 5);
    expect(at('2026-10-15T00:00:00Z').autumn).toBeCloseTo(1, 5);
  });

  it('is continuous and a partition on every day of the year', () => {
    let previous = seasonWeights(new Date('2026-01-01T12:00:00Z'));
    for (let day = 1; day <= 365; day += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + day, 12));
      const next = seasonWeights(date);
      for (const key of ['spring', 'summer', 'autumn', 'winter'] as const) {
        // The membership cross-fade spans ~18 days; smoothstep peaks at
        // ~0.083/day. A bigger step would mean a calendar boundary leaked in.
        expect(Math.abs(next[key] - previous[key])).toBeLessThan(0.09);
        expect(next[key]).toBeGreaterThanOrEqual(0);
        expect(next[key]).toBeLessThanOrEqual(1);
      }
      expect(Math.abs(next.autumnMix - previous.autumnMix)).toBeLessThan(0.06);
      expect(Math.abs(next.winterMix - previous.winterMix)).toBeLessThan(0.06);
      expect(seasonMembershipSum(next)).toBeCloseTo(1, 9);
      previous = next;
    }
  });

  it('does not expose winter through the UI-facing season enum', () => {
    // The weights are internal; `seasonForDate`/`parseSeason` still route the
    // cold months to the autumn look until the winter content is accepted.
    expect(seasonForDate(new Date('2027-01-15T00:00:00Z'))).toBe('autumn');
    expect(parseSeason('winter')).toBeNull();
  });
});

describe('autumn appearance and phase', () => {
  it('gives autumn a summer base, several autumn tones and a green conifer palette', () => {
    const autumn = seasonAppearance('autumn');
    expect(autumn.basePalette).toEqual(['#52783c', '#648749', '#73944f', '#456b36']);
    expect(autumn.autumnPalette).toHaveLength(4);
    expect(autumn.autumnPalette).toEqual(['#c9a13b', '#c07a32', '#9a5a2e', '#8a7a34']);
    expect(autumn.canopyPalette).toEqual(autumn.autumnPalette);
    expect(autumn.coniferPalette).toEqual(['#3f5b34', '#4a6a3c', '#557a45', '#36502c']);
    // Spring/summer blend from their own palette (no residual autumn).
    expect(seasonAppearance('spring').basePalette).toEqual(seasonAppearance('spring').canopyPalette);
    expect(seasonAppearance('summer').basePalette).toEqual(seasonAppearance('summer').canopyPalette);
  });

  it('pins full autumn for a QA override and keeps a floor in the cold months', () => {
    expect(seasonAutumnMix('summer', new Date('2026-10-15T00:00:00Z'))).toBe(0);
    expect(seasonAutumnMix('spring', new Date('2026-10-15T00:00:00Z'))).toBe(0);
    expect(seasonAutumnMix('autumn', new Date('2026-07-15T00:00:00Z'), true)).toBe(1);
    expect(seasonAutumnMix('autumn', new Date('2026-10-15T00:00:00Z'))).toBeGreaterThan(0.4);
    // The UI maps winter months to autumn; the trees must not go summer-green.
    expect(seasonAutumnMix('autumn', new Date('2027-01-15T00:00:00Z'))).toBeGreaterThanOrEqual(0.65);
  });
});
