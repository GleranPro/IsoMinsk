/**
 * Seasons for the atmosphere pass (backlog B-7).
 *
 * The season comes from the real calendar date by default (meteorological
 * seasons; Minsk is northern hemisphere) and drives two things:
 *  - the tree canopy palette (runtime recolour, no tile rebuild — see
 *    `TileStreamer.setCanopyAppearance`);
 *  - the snow amount in the surface shaders (see `cloudShade.ts`).
 *
 * Pure math, no THREE: tests pin concrete dates.
 */

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** Meteorological season from a calendar month (northern hemisphere). */
export function seasonForDate(date: Date = new Date()): Season {
  const month = date.getUTCMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'autumn';
  return 'winter';
}

export function parseSeason(value: string | null): Season | null {
  switch (value) {
    case 'spring':
    case 'summer':
    case 'autumn':
    case 'winter':
      return value;
    default:
      return null;
  }
}

/** Summer keeps the baseline canopy palette (see treeInstances.ts). */
export const SEASON_CANOPY_PALETTES: Record<Season, readonly string[] | null> = {
  spring: ['#5f8a44', '#74a052', '#84ad5c', '#52783c'],
  summer: null,
  autumn: ['#8a7a34', '#a3873a', '#a05f2c', '#6e6a30'],
  winter: null,
};

/** Snow amount (0..1) fed to the surface shaders per season. */
export const SEASON_SNOW: Record<Season, number> = {
  spring: 0,
  summer: 0,
  autumn: 0,
  winter: 0.72,
};

/** Winter canopy hides (bare branches — trunks stay visible). */
export const SEASON_CANOPY_VISIBLE: Record<Season, boolean> = {
  spring: true,
  summer: true,
  autumn: true,
  winter: false,
};

export interface SeasonAppearance {
  season: Season;
  canopyPalette: readonly string[] | null;
  canopyVisible: boolean;
  snow: number;
}

export function seasonAppearance(season: Season): SeasonAppearance {
  return {
    season,
    canopyPalette: SEASON_CANOPY_PALETTES[season],
    canopyVisible: SEASON_CANOPY_VISIBLE[season],
    snow: SEASON_SNOW[season],
  };
}
