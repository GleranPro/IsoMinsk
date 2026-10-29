/**
 * Road-detail colours: paint, cycle lanes, surface tints, medians, bridges.
 *
 * Kept in one small module so road geometry and crossing geometry agree on the
 * exact tones (paint must read as one material system at pixel-art scale) and
 * so the palette module stays owned by art direction. All values are sRGB hex;
 * the environment material linearises vertex colours.
 */

import type { RoadClass, RoadPolygon } from '../../shared/types';
import {
  ENV_PALETTE,
  ROAD_PALETTE,
  SIDEWALK_COLOR,
  mixHex,
  shadeHex,
  type Hex,
} from '../../engine/materials/palette';

/** Painted lane markings: warm off-white derived from the pavement colour. */
export const MARKING_BAR_COLOR: Hex = shadeHex(SIDEWALK_COLOR, 0.55);
/** Slightly dimmer paint for stop lines (reads as worn paint, not glare). */
export const MARKING_BAR_DIM_COLOR: Hex = shadeHex(MARKING_BAR_COLOR, -0.12);
/** Painted cycle lane: muted brick red. */
export const BIKE_LANE_COLOR: Hex = mixHex('#a24b3b', SIDEWALK_COLOR, 0.18);
/** Median lawn and stone tones (deterministic per avenue). */
export const MEDIAN_LAWN_COLOR: Hex = mixHex(ENV_PALETTE.grass, ENV_PALETTE.grassDark, 0.35);
export const MEDIAN_STONE_COLOR: Hex = mixHex(SIDEWALK_COLOR, '#8d8a80', 0.5);
/** Bridge parapetry / railings and pier concrete (light concrete, reads on dark asphalt). */
export const BRIDGE_RAIL_COLOR: Hex = '#b9b4a7';
export const BRIDGE_PIER_COLOR: Hex = '#9a968c';

/**
 * Surface tints keyed by the OSM `surface` value carried in the payload.
 * Only entries present here change the asphalt tone; `asphalt` and unknown
 * surfaces keep the class colour.
 */
const SURFACE_TINTS: Readonly<Record<string, Hex>> = {
  paving_stones: '#a49c8f',
  paving_stone: '#a49c8f',
  concrete: '#908e88',
  paved: '#8b8882',
  cobblestone: '#7e776e',
  sett: '#7e776e',
  ground: '#8c8068',
  dirt: '#8a7c63',
  compacted: '#8e846f',
  gravel: '#948b76',
};

/** Carriageway colour: class colour modulated by the mapped surface. */
export function roadSurfaceColor(road: Pick<RoadPolygon, 'class' | 'surface'>): Hex {
  const base = ROAD_PALETTE[road.class] ?? ROAD_PALETTE.unknown;
  if (!road.surface) return base;
  const tint = SURFACE_TINTS[road.surface];
  return tint ? mixHex(base, tint, 0.42) : base;
}

/** Dedicated cycleway polygons are painted red-brown instead of pavement grey. */
export function cyclewayColor(): Hex {
  return mixHex(ROAD_PALETTE.cycleway, '#9c4b3c', 0.8);
}

/** Deterministic median material pick: most avenues get a lawn strip. */
export function medianColor(seed: number): Hex {
  return (Math.abs(Math.round(seed)) & 1) === 0 ? MEDIAN_LAWN_COLOR : MEDIAN_STONE_COLOR;
}

/** Stable hash of a road name/class for deterministic decoration choices. */
export function roadSeed(road: Pick<RoadPolygon, 'class' | 'name'>): number {
  const text = `${road.class}:${road.name ?? ''}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

/** Road class tint for debug/tests (re-export avoids a second palette import). */
export function classColor(cls: RoadClass): Hex {
  return ROAD_PALETTE[cls] ?? ROAD_PALETTE.unknown;
}
