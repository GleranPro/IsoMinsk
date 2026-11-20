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

import { CANOPY_PALETTE } from '../../city/environment/treeInstances';

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

/**
 * Canopy palette per season. Every season sets an EXPLICIT palette — a "null
 * means keep current" would leave the previous season's colours behind a
 * runtime switch (the summer-stays-autumn bug). Winter keeps a palette too;
 * it is just hidden by SEASON_CANOPY_VISIBLE.
 */
export const SEASON_CANOPY_PALETTES: Record<Season, readonly string[]> = {
  spring: ['#5f8a44', '#74a052', '#84ad5c', '#52783c'],
  summer: CANOPY_PALETTE,
  autumn: ['#8a7a34', '#a3873a', '#a05f2c', '#6e6a30'],
  winter: ['#5b6b4e', '#64745a', '#6e7a5c', '#526040'],
};

/** Snow amount (0..1) fed to the surface shaders per season. Snow lands only
 * on up-facing surfaces (ground/roofs — see cloudShade.ts), so the city stays
 * readable. */
export const SEASON_SNOW: Record<Season, number> = {
  spring: 0,
  summer: 0,
  autumn: 0,
  winter: 0.48,
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
  canopyPalette: readonly string[];
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
