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

import type { Archetype, RoofShape, RoadClass, SurfaceKind } from '../../shared/types';

export type Hex = string;

/** Base environment colours. */
export const ENV_PALETTE = {
  ground: '#7e8674',
  groundDark: '#6b7263',
  grass: '#7d9a52',
  grassDark: '#6b8846',
  park: '#6f9247',
  forest: '#5a7c42',
  scrub: '#8a9a68',
  sand: '#c8b992',
  pitch: '#8f9c7a',
  cemetery: '#7a8a6a',
  plaza: '#b0a99b',
  residential: '#8d8d80',
  industrial: '#8b8b81',
  commercial: '#96928a',
  construction: '#9c9275',
  unknown: '#7e8674',
  water: '#6d95ab',
  waterDeep: '#5f83a0',
  river: '#6b90a8',
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
export const TREE_COLORS: Hex[] = ['#4f7340', '#5c8046', '#6b8f4d', '#7a9a55'];
export const TREE_TRUNK_COLOR: Hex = '#5a4632';

/** Roof colours by shape and archetype-ish family. */
export const ROOF_COLORS = {
  flat: ['#8a877c', '#7d7b71', '#948f83', '#73736c'],
  // Muted grey-brown tiles (Minsk centre roofs read warm, not terracotta-bright).
  sloped: ['#8f6350', '#82584a', '#9a6d56', '#755547'],
  metal: ['#7b8388', '#6b7378', '#878f94'],
  thatch: ['#a58a5c'],
} as const;

/** Facade base colours per archetype (pseudo-random pick by building seed). */
export const ARCHETYPE_COLORS: Record<Archetype, Hex[]> = {
  // Warm plaster / stone — the grand Stalinist ensembles on the avenue.
  stalin: ['#c4ad8b', '#cdb795', '#bda584', '#c9b394', '#c0b39c', '#b6a381'],
  // Washed-out warm concrete of the 5-storey Khrushchev blocks.
  khrushchev: ['#bcb6a6', '#c4bdaa', '#b1aa9b', '#c9c1ae', '#a9a292', '#c6bfae'],
  // Cool, monotonous Brezhnev panel concrete.
  panel: ['#aeb2b0', '#b8b8b0', '#a5abac', '#bfbdb2', '#9ba1a3', '#c2bfb5'],
  // Light glassy modern towers with a hint of blue-grey.
  modern: ['#c9cbc6', '#b4bfc0', '#a5b8ba', '#cdc9be', '#8ca6aa'],
  // Neutral commerical/office cladding.
  office: ['#b2b6b3', '#a5aaad', '#bdbab0', '#9ba3a5', '#c6c0b0'],
  // Pre-war plaster and brick: warmer, more varied.
  historic: ['#a5765b', '#ad8467', '#c2b08f', '#a17f66', '#bba17f', '#946e58'],
  // Industrial sheds: olive-grey.
  industrial: ['#93948b', '#888a83', '#9d998c', '#82857e'],
  // Sheds, garages, kiosks.
  small: ['#a59c8e', '#ada393', '#998f81', '#b3a999'],
  // Pale stone civic / cultural buildings.
  civic: ['#cbc2ad', '#c4bcaa', '#d0c8b3', '#bab3a1'],
} as const;

/** Window glass colours. */
export const WINDOW_COLORS = {
  glass: '#37454c',
  glassLight: '#586a72',
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
