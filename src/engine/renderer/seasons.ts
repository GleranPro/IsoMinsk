/**
 * Seasons for the atmosphere pass (backlog B-7).
 *
 * The season comes from the real calendar date by default (meteorological
 * seasons; Minsk is northern hemisphere) and drives the tree canopy palette
 * (runtime recolour, no tile rebuild — see `TileStreamer.setCanopyAppearance`).
 *
 * WINTER IS INTENTIONALLY ABSENT (owner decision, 2026-11-20): a convincing
 * winter needs designed content — clean roads, snowdrifts on sidewalks, clean
 * non-white facades — not a uniform whitening shader. Until that exists the
 * cold months fall back to the autumn look.
 *
 * Pure math, no THREE: tests pin concrete dates.
 */

import { CANOPY_PALETTE } from '../../city/environment/treeInstances';

export type Season = 'spring' | 'summer' | 'autumn';

/** Meteorological season from a calendar month (northern hemisphere); the
 * cold months fall back to autumn until a designed winter ships. */
export function seasonForDate(date: Date = new Date()): Season {
  const month = date.getUTCMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  return 'autumn';
}

export function parseSeason(value: string | null): Season | null {
  switch (value) {
    case 'spring':
    case 'summer':
    case 'autumn':
      return value;
    default:
      return null;
  }
}

/**
 * Canopy palette per season; every season sets an EXPLICIT palette (a "null
 * means keep current" left the previous season's colours behind a runtime
 * switch — the summer-stays-autumn bug). Spring is visibly lighter and
 * yellower than summer's deep green; autumn goes orange/rust.
 */
export const SEASON_CANOPY_PALETTES: Record<Season, readonly string[]> = {
  spring: ['#9ab95e', '#aac66d', '#8fb257', '#7ca44f'],
  summer: CANOPY_PALETTE,
  autumn: ['#8a7a34', '#a3873a', '#a05f2c', '#6e6a30'],
};

export interface SeasonAppearance {
  season: Season;
  canopyPalette: readonly string[];
}

export function seasonAppearance(season: Season): SeasonAppearance {
  return { season, canopyPalette: SEASON_CANOPY_PALETTES[season] };
}
