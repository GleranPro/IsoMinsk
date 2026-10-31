/**
 * Isometric Minsk — art direction palette.
 *
 * A deliberately limited, slightly desaturated palette that reads well at
 * pixel-art resolutions: warm masonry, cool panel concrete, muted greens and a
 * cold river blue. All colours are sRGB hex; the renderer linearises them.
 *
 * Owned by the art-direction/facades module. Other modules *read* these values;
 * keep the exported names stable.
 */

import type { Archetype, RoofShape, RoadClass, RoadMaterial, SurfaceKind } from '../../shared/types';

export type Hex = string;

/** Base environment colours. */
export const ENV_PALETTE = {
  ground: '#7e8674',
  groundDark: '#6b7263',
  grass: '#6b9a4a',
  grassDark: '#5f8f3d',
  park: '#5f8f3d',
  forest: '#527d34',
  scrub: '#8a9f62',
  sand: '#c8b992',
  pitch: '#8f9c7a',
  cemetery: '#7a8a6a',
  plaza: '#b0a99b',
  residential: '#8d8d80',
  industrial: '#8b8b81',
  commercial: '#96928a',
  construction: '#9c9275',
  unknown: '#7e8674',
  water: '#4d7f9e',
  waterDeep: '#41718f',
  river: '#447996',
  railway: '#7f776f',
  railBallast: '#8a8175',
} as const;

/**
 * Asphalt and pavement colours by road class.
 *
 * Roads stay the darkest large family (they anchor the isometric picture) but
 * are lifted into the #66..#8a sRGB range: the previous near-#45 values turned
 * into near-black voids after lighting/tonemapping/quantisation.
 */
export const ROAD_PALETTE: Record<RoadClass, Hex> = {
  motorway: '#6a6e74',
  trunk: '#6c7076',
  primary: '#6e7278',
  secondary: '#72767c',
  tertiary: '#767a80',
  residential: '#7a7e84',
  service: '#83878c',
  living_street: '#85898e',
  pedestrian: '#b3ab9c',
  footway: '#aca595',
  cycleway: '#9a9c8d',
  path: '#a39c8d',
  steps: '#a39c8d',
  track: '#8d8778',
  unknown: '#73777d',
};

/** Sidewalk / kerb tint used for the road shoulder ring. */
export const SIDEWALK_COLOR: Hex = '#a9a293';

/**
 * Normalized road surface materials (payload 0.2.0): one flat tone per
 * material, no per-class tints. Applied to non-overlapping partition pieces,
 * so a material change is a crisp shared edge instead of stacked polygons.
 *
 * Starting values tuned for pixel-art scale: asphalt stays the darkest large
 * family, sett/cobblestone reads warmer and lighter, concrete is neutral,
 * ground/dirt is warm brown-grey.
 */
export const SURFACE_COLORS: Record<RoadMaterial, Hex> = {
  asphalt: ROAD_PALETTE.primary,
  stone: '#8a8478',
  concrete: '#8d9089',
  unpaved: '#8c8068',
};

/** Paving / sidewalk tone of the normalized partition. */
export const PAVING_COLOR: Hex = SIDEWALK_COLOR;

/** Kerb strip tone: darker than paving, lighter than asphalt. */
export const KERB_COLOR: Hex = mixHex(ROAD_PALETTE.primary, SIDEWALK_COLOR, 0.45);

/** Median strip between paired one-way carriageways. */
export const MEDIAN_COLOR: Hex = mixHex(ENV_PALETTE.grass, SIDEWALK_COLOR, 0.35);

/** Painted lane markings / zebra bars: warm off-white derived from the pavement. */
export const MARKING_COLOR: Hex = shadeHex(SIDEWALK_COLOR, 0.55);
/** Slightly dimmer paint for stop lines (reads as worn paint, not glare). */
export const MARKING_COLOR_DIM: Hex = shadeHex(MARKING_COLOR, -0.12);

/** Effective road width by class in metres (used when OSM has no `width`). */
export const ROAD_WIDTH_M: Record<RoadClass, number> = {
  motorway: 22,
  trunk: 20,
  primary: 18,
  secondary: 15,
  tertiary: 13,
  residential: 9,
  service: 5.5,
  living_street: 6,
  pedestrian: 8,
  footway: 2.5,
  cycleway: 2.5,
  path: 2,
  steps: 2.5,
  track: 3.5,
  unknown: 6,
};

/** Tree canopy colours (variation index 0..3). */
export const TREE_COLORS: Hex[] = ['#4a7333', '#568039', '#639040', '#719c4b'];
export const TREE_TRUNK_COLOR: Hex = '#5a4632';

/**
 * Roof colours by shape and archetype-ish family.
 *
 * Aerial views of Minsk read strongly by roof: terracotta / red-brown pitched
 * roofs against slate-grey flat roofs. These are deliberately chromatic so that
 * dither/levels quantisation keeps the distinction (global palette snapping is
 * off by default).
 */
export const ROOF_COLORS = {
  flat: ['#7b7f80', '#6e7274', '#828687', '#737778'],
  sloped: ['#a8613f', '#96553a', '#b4704a', '#8a4f38'],
  metal: ['#7d8588', '#6f777a', '#8a9295'],
  thatch: ['#a58a5c'],
} as const;

/**
 * Facade base colours per archetype (pseudo-random pick by building seed).
 *
 * Art direction: at a 560 m overview the city must still read as at least four
 * colour families, so the families are pushed apart in hue while staying a
 * little desaturated:
 *   stalin      warm ochre / sand
 *   khrushchev  pale grey-green with brick-red accents
 *   panel       light cool concrete (darker joint bands come from the shader)
 *   modern      glassy teal
 *   office      neutral cool grey
 *   historic    ochre / rose plaster
 *   industrial  olive grey
 *   small       warm grey
 *   civic       pale stone
 */
export const ARCHETYPE_COLORS: Record<Archetype, Hex[]> = {
  stalin: ['#c39a63', '#cba66f', '#b98f58', '#d0b078', '#c7a166', '#bd955f'],
  khrushchev: ['#b7bda4', '#c1c7af', '#adb39a', '#a86a52', '#b07a5e', '#b4b9a0'],
  panel: ['#b2bcbf', '#a6b1b5', '#bfc5c5', '#aab5b9', '#9fabb0', '#b8c0c1'],
  modern: ['#a7c3c5', '#93b6ba', '#b7cfcd', '#8fb0b3', '#9dbdc0'],
  office: ['#a9b1b3', '#9ba5a9', '#b7bdbb', '#909ba0', '#b3b8b4'],
  historic: ['#b98a63', '#c49a76', '#b07a62', '#c9a181', '#b98b76', '#a97a58'],
  industrial: ['#9a9b8e', '#8f9186', '#a4a496', '#95968a'],
  small: ['#b0a694', '#a89d8a', '#b8ae9c', '#a1968a'],
  civic: ['#cbc2ad', '#d2ccbb', '#bdb7a6', '#c6beac'],
  // Monumental civic ensembles: desaturated warm sandstone (beige / grey).
  palace: ['#c9b490', '#d2c09e', '#c0aa86', '#ccb996', '#c6b18d', '#c3ae8a'],
  // Stadium / arena concrete.
  stadium: ['#9a9e9e', '#8f9393', '#a4a7a6', '#969a99'],
} as const;

/** Window glass colours. */
export const WINDOW_COLORS = {
  glass: '#2f3b42',
  glassLight: '#4b5d66',
  nightLit: '#e2bf6e',
  nightLitWarm: '#eed28d',
  nightDark: '#222a30',
  shopfront: '#2d383e',
} as const;

/**
 * Base colour for cornice / parapet / ledge faces before per-face variation.
 * Light warm stone so trim reads even in flat shadow at low resolution.
 */
export const FACADE_TRIM_COLOR: Hex = '#d6cfbf';

/** Base colour for shopfront / ground-floor glazing panels. */
export const FACADE_GROUND_COLOR: Hex = '#5a5a52';

/** Roof colour picker (deterministic by seed). */
export function pickRoofColor(shape: RoofShape, seed: number): Hex {
  const family =
    shape === 'flat' || shape === 'complex' || shape === 'dome'
      ? ROOF_COLORS.flat
      : shape === 'skillion'
        ? ROOF_COLORS.metal
        : ROOF_COLORS.sloped;
  const idx = Math.floor(fract(seed * 911.7) * family.length) % family.length;
  return family[idx];
}

/** Facade colour picker (deterministic by seed). */
export function pickFacadeColor(archetype: Archetype, seed: number): Hex {
  const palette = ARCHETYPE_COLORS[archetype] ?? ARCHETYPE_COLORS.small;
  const idx = Math.floor(fract(seed * 547.3 + 0.13) * palette.length) % palette.length;
  return palette[idx];
}

/** Surface colour for a ground polygon kind. */
export function surfaceColor(kind: SurfaceKind): Hex {
  switch (kind) {
    case 'grass':
      return ENV_PALETTE.grass;
    case 'park':
      return ENV_PALETTE.park;
    case 'forest':
      return ENV_PALETTE.forest;
    case 'scrub':
      return ENV_PALETTE.scrub;
    case 'sand':
      return ENV_PALETTE.sand;
    case 'pitch':
      return ENV_PALETTE.pitch;
    case 'cemetery':
      return ENV_PALETTE.cemetery;
    case 'plaza':
      return ENV_PALETTE.plaza;
    case 'residential':
      return ENV_PALETTE.residential;
    case 'industrial':
      return ENV_PALETTE.industrial;
    case 'commercial':
      return ENV_PALETTE.commercial;
    case 'construction':
      return ENV_PALETTE.construction;
    case 'water':
      return ENV_PALETTE.water;
    case 'river':
      return ENV_PALETTE.river;
    case 'railway':
      return ENV_PALETTE.railway;
    default:
      return ENV_PALETTE.unknown;
  }
}

/**
 * Trim / cornice colour for a facade base colour: a warmer, lighter stone than
 * the wall so cornices and pilaster caps read at low resolution.
 */
export function trimColorFor(base: Hex): Hex {
  return mixHex(shadeHex(base, 0.08), FACADE_TRIM_COLOR, 0.32);
}

/** Multiply a hex colour's channels (factor > 0 brightens, < 0 darkens). */
export function shadeHex(hex: Hex, factor: number): Hex {
  const { r, g, b } = hexToRgb(hex);
  const f = 1 + factor;
  return rgbToHex(
    clamp(Math.round(r * f), 0, 255),
    clamp(Math.round(g * f), 0, 255),
    clamp(Math.round(b * f), 0, 255),
  );
}

export function hexToRgb(hex: Hex): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): Hex {
  const to = (v: number) => v.toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Mix two hex colours. */
export function mixHex(a: Hex, b: Hex, t: number): Hex {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(
    Math.round(ca.r + (cb.r - ca.r) * t),
    Math.round(ca.g + (cb.g - ca.g) * t),
    Math.round(ca.b + (cb.b - ca.b) * t),
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function fract(v: number): number {
  return v - Math.floor(v);
}

/**
 * Time-of-day lighting presets. `hours` is the local solar time.
 *
 * These are the *relative* light colour/intensity curve of the day; the
 * renderer owns final exposure (tone mapping / post pass) and may scale these
 * when raising overall brightness. Do not inflate them to compensate for a dark
 * post pipeline — adjust palette values or exposure instead.
 */
export interface TimeOfDayPreset {
  key: string;
  label: string;
  hours: number;
  sunColor: Hex;
  sunIntensity: number;
  ambientColor: Hex;
  ambientIntensity: number;
  skyColor: Hex;
  groundColor: Hex;
  fogColor: Hex;
  fogNear: number;
  fogFar: number;
  shadowOpacity: number;
  /** 0..1, how many windows are lit (night scene). */
  nightFactor: number;
}

export const TIME_OF_DAY_PRESETS: TimeOfDayPreset[] = [
  {
    key: 'dawn',
    label: 'Dawn',
    hours: 5.5,
    sunColor: '#f2b98a',
    sunIntensity: 1.15,
    ambientColor: '#8e94b5',
    ambientIntensity: 0.62,
    skyColor: '#cfd6e6',
    groundColor: '#6b6a5e',
    fogColor: '#cfd6e6',
    fogNear: 2600,
    fogFar: 7200,
    shadowOpacity: 0.42,
    nightFactor: 0.25,
  },
  {
    key: 'morning',
    label: 'Morning',
    hours: 9,
    sunColor: '#fff0d2',
    sunIntensity: 2.05,
    ambientColor: '#a9bdd6',
    ambientIntensity: 0.5,
    skyColor: '#dfe6ec',
    groundColor: '#6f7162',
    fogColor: '#dfe6ec',
    fogNear: 3000,
    fogFar: 8000,
    shadowOpacity: 0.5,
    nightFactor: 0,
  },
  {
    key: 'noon',
    label: 'Noon',
    hours: 13,
    sunColor: '#fff6e0',
    sunIntensity: 2.25,
    ambientColor: '#b7c9da',
    ambientIntensity: 0.52,
    skyColor: '#e6ecef',
    groundColor: '#727466',
    fogColor: '#e6ecef',
    fogNear: 3200,
    fogFar: 8600,
    shadowOpacity: 0.55,
    nightFactor: 0,
  },
  {
    key: 'golden',
    label: 'Golden hour',
    hours: 18.5,
    sunColor: '#ffce8a',
    sunIntensity: 1.85,
    ambientColor: '#9aa8c4',
    ambientIntensity: 0.48,
    skyColor: '#e9d9bd',
    groundColor: '#6d6a5c',
    fogColor: '#e6d6bc',
    fogNear: 2800,
    fogFar: 7600,
    shadowOpacity: 0.55,
    nightFactor: 0.12,
  },
  {
    key: 'dusk',
    label: 'Dusk',
    hours: 21,
    sunColor: '#e2a878',
    sunIntensity: 0.75,
    ambientColor: '#6f7ea4',
    ambientIntensity: 0.5,
    skyColor: '#8e9bb5',
    groundColor: '#4e4f4a',
    fogColor: '#8e9bb5',
    fogNear: 2200,
    fogFar: 6600,
    shadowOpacity: 0.35,
    nightFactor: 0.55,
  },
  {
    key: 'night',
    label: 'Night',
    hours: 23,
    sunColor: '#8fa5c6',
    sunIntensity: 0.34,
    ambientColor: '#3f4c68',
    ambientIntensity: 0.62,
    skyColor: '#232d40',
    groundColor: '#1c2129',
    fogColor: '#232d40',
    fogNear: 1800,
    fogFar: 6200,
    shadowOpacity: 0.28,
    nightFactor: 1,
  },
];
