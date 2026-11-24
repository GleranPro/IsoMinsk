import { describe, expect, it } from 'vitest';

import { minskLocalHours } from '../../../src/engine/renderer/minskTime';

describe('minskLocalHours', () => {
  it('converts UTC midnight to 03:00 Minsk (UTC+3, no DST)', () => {
    expect(minskLocalHours(new Date('2026-11-20T00:00:00Z'))).toBeCloseTo(3, 6);
  });

  it('maps 15:00Z to 18:00 Minsk', () => {
    expect(minskLocalHours(new Date('2026-11-20T15:00:00Z'))).toBeCloseTo(18, 6);
  });

  it('wraps past midnight (21:30Z -> 00:30 next day)', () => {
    expect(minskLocalHours(new Date('2026-11-20T21:30:00Z'))).toBeCloseTo(0.5, 6);
  });

  it('keeps fractional minutes', () => {
    // 09:41:23Z -> 12:41:23 Minsk = 12 + 41/60 + 23/3600 hours.
    const expected = 12 + 41 / 60 + 23 / 3600;
    expect(minskLocalHours(new Date('2026-11-20T09:41:23Z'))).toBeCloseTo(expected, 4);
  });

  it('defaults to the current moment within the valid hour range', () => {
    const hours = minskLocalHours();
    expect(hours).toBeGreaterThanOrEqual(0);
    expect(hours).toBeLessThan(24);
  });
});
