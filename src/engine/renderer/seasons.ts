/**
 * Seasons for the atmosphere pass (backlog B-7).
 *
 * The season comes from the real calendar date by default (meteorological
 * seasons; Minsk is northern hemisphere) and drives the tree canopy palette
 * (runtime recolour, no tile rebuild — see `TileStreamer.setCanopyAppearance`).
 *
 * Winter is a first-class season (owner request, 2026-11-24): the per-surface
 * snow mask (`uWinter`, painted into the ground texture and read by the
 * facade/roof shaders), bare broadleaf crowns and the low cold sun were already
 * installed, so the season is exposed in the UI and on the calendar again.
 * The rejected global `uSnowAmount` whitening is still not used.
 *
 * Pure math, no THREE: tests pin concrete dates.
 */

import { CANOPY_PALETTE } from '../../city/environment/treeInstances';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** Meteorological season from a calendar month (northern hemisphere). */
export function seasonForDate(date: Date = new Date()): Season {
  const month = date.getUTCMonth();
  if (month === 11 || month <= 1) return 'winter';
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  return 'autumn';
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
 * Canopy palette per season; every season sets an EXPLICIT palette (a "null
 * means keep current" left the previous season's colours behind a runtime
 * switch — the summer-stays-autumn bug). Spring is visibly lighter and
 * yellower than summer's deep green; autumn goes yellow/orange/rust. Winter
 * broadleaf crowns are hidden in favour of bare-branch templates, so its
 * palette is a muted bark tone rather than foliage.
 */
export const SEASON_CANOPY_PALETTES: Record<Season, readonly string[]> = {
  spring: ['#9ab95e', '#aac66d', '#8fb257', '#7ca44f'],
  summer: CANOPY_PALETTE,
  // Several species tones in one palette; the per-tree phase (autumnMix ×
  // variation) decides which tree has already turned.
  autumn: ['#c9a13b', '#c07a32', '#9a5a2e', '#8a7a34'],
  winter: ['#6f5b46', '#7a6650', '#5e4c3b', '#86705a'],
};

/** Conifers stay green through autumn and winter (no leaf-off). */
export const CONIFER_CANOPY_PALETTE: readonly string[] = [
  '#3f5b34',
  '#4a6a3c',
  '#557a45',
  '#36502c',
];

export interface SeasonAppearance {
  season: Season;
  /** Final palette for the season (spring foliage, summer green, autumn tones). */
  canopyPalette: readonly string[];
  /**
   * Broadleaf base the autumn phase blends FROM (summer green in autumn).
   * Spring/summer use their own palette here.
   */
  basePalette: readonly string[];
  /** Broadleaf autumn target for the phase blend. */
  autumnPalette: readonly string[];
  /** Green palette for conifers, independent of the broadleaf phase. */
  coniferPalette: readonly string[];
}

export function seasonAppearance(season: Season): SeasonAppearance {
  if (season === 'autumn') {
    return {
      season,
      canopyPalette: SEASON_CANOPY_PALETTES.autumn,
      basePalette: CANOPY_PALETTE,
      autumnPalette: SEASON_CANOPY_PALETTES.autumn,
      coniferPalette: CONIFER_CANOPY_PALETTE,
    };
  }
  const palette = SEASON_CANOPY_PALETTES[season];
  return {
    season,
    canopyPalette: palette,
    basePalette: palette,
    autumnPalette: SEASON_CANOPY_PALETTES.autumn,
    coniferPalette: CONIFER_CANOPY_PALETTE,
  };
}

// ---------------------------------------------------------------------------
// continuous weights (season P0)
// ---------------------------------------------------------------------------

/**
 * Continuous season weights for the surface shaders.
 *
 * `seasonForDate` drives the UI season and the canopy look; these weights are
 * the *intensity* layer of the new surface model
 * (docs/SEASONS_TECHNICAL_PLAN.md §10.1): `winterMix` feeds `uWinter`, so snow
 * can appear gradually through December instead of popping on 1 December.
 * The shipped UI still switches the mask at the season boundary; the ramps are
 * kept for the planned continuous weather pass.
 *
 * Month ramps (progress inside the month, smoothstep):
 *   autumn  Sep 0→0.4, Oct 0.4→0.9, Nov 0.9→1, Dec 1→0
 *   winter  Dec 0→0.7, Jan 0.7→1, Feb 1→0.8, Mar 0.8→0
 *
 * `autumn`/`winter` (and spring/summer) are season *membership* weights that
 * cross-fade over the first ~20% of a season (≈18 days), so a calendar
 * boundary never changes a value in one step. Pure math — no THREE.
 */
export interface SeasonWeights {
  spring: number;
  summer: number;
  autumn: number;
  winter: number;
  /** 0..1 inside autumn: canopy palette and leaf-litter phase. */
  autumnMix: number;
  /** 0..1 inside winter: `uWinter`, the snow-depth multiplier. */
  winterMix: number;
}

/** Cross-fade band at the start of a season, as a fraction of the season. */
const SEASON_BLEND = 0.2;
/** Calendar month in which each season starts (winter starts in December). */
const SEASON_START_MONTH = [11, 2, 5, 8] as const;

/** Progress through the UTC calendar month, 0 at the 1st 00:00 → 1 next month. */
function monthProgress(date: Date): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = Date.UTC(year, month, 1);
  const end = Date.UTC(year, month + 1, 1);
  const t = (date.getTime() - start) / (end - start);
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Index in the season cycle (winter = Dec–Feb, spring = Mar–May…). */
function seasonIndexForMonth(month: number): number {
  if (month === 11 || month <= 1) return 0;
  if (month <= 4) return 1;
  if (month <= 7) return 2;
  return 3;
}

/** Month offset inside the season: 0..2. */
function monthInSeason(month: number, index: number): number {
  return (month - SEASON_START_MONTH[index] + 12) % 12;
}

/** Autumn phase: rises through September–November, hands over in December. */
function autumnMixFor(month: number, t: number): number {
  switch (month) {
    case 8: // September
      return 0.4 * smooth(t);
    case 9: // October
      return 0.4 + 0.5 * smooth(t);
    case 10: // November
      return 0.9 + 0.1 * smooth(t);
    case 11: // December: autumn fades as the snow arrives
      return 1 - smooth(t);
    default: // January–August
      return 0;
  }
}

/** Winter phase: snow builds in December, peaks in January, melts in March. */
function winterMixFor(month: number, t: number): number {
  switch (month) {
    case 11: // December
      return 0.7 * smooth(t);
    case 0: // January
      return 0.7 + 0.3 * smooth(t);
    case 1: // February
      return 1 - 0.2 * smooth(t);
    case 2: // March: melt towards spring
      return 0.8 * (1 - smooth(t));
    default: // April–November
      return 0;
  }
}

export function seasonWeights(date: Date = new Date()): SeasonWeights {
  const month = date.getUTCMonth();
  const t = monthProgress(date);
  const index = seasonIndexForMonth(month);
  const progress = (monthInSeason(month, index) + t) / 3;

  // Cross-fade from the previous season during the first SEASON_BLEND of the
  // new one; the pair always sums to 1.
  const membership = [0, 0, 0, 0];
  if (progress >= SEASON_BLEND) {
    membership[index] = 1;
  } else {
    const k = smooth(progress / SEASON_BLEND);
    membership[index] = k;
    membership[(index + 3) % 4] = 1 - k;
  }

  return {
    winter: membership[0],
    spring: membership[1],
    summer: membership[2],
    autumn: membership[3],
    autumnMix: autumnMixFor(month, t),
    winterMix: winterMixFor(month, t),
  };
}

/** Sanity check for callers/tests: membership weights form a partition. */
export function seasonMembershipSum(weights: SeasonWeights): number {
  return weights.spring + weights.summer + weights.autumn + weights.winter;
}

/**
 * Autumn phase actually shown by the UI.
 *
 * Winter keeps the phase at 0 (leaves and yellow grass under snow were the red
 * and green speckles seen through the cover). A pinned `?season=autumn` is
 * always full strength; the floor keeps early autumn from reading as summer.
 */
export function seasonAutumnMix(
  season: Season,
  date: Date = new Date(),
  pinned = false,
): number {
  if (season !== 'autumn') return 0;
  if (pinned) return 1;
  return Math.max(0.65, seasonWeights(date).autumnMix);
}
