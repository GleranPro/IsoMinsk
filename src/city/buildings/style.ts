/**
 * Per-building style context + vertex attribute surfaces.
 *
 * Colours follow src/shared/geometry.ts: `aColor` carries **sRGB** values in
 * 0..1 (the facade shader linearises in GLSL). All presets are read through
 * `src/city/facades/presets.ts` so facade value refinements propagate.
 */

import type { Archetype, BuildingFeature, RoofShape } from '../../shared/types';
import { ARCHETYPE_ID } from '../../shared/geometry';
import { hexToRgb, pickFacadeColor, pickRoofColor, trimColorFor } from '../../engine/materials/palette';
import { presetFor } from '../facades/presets';
import { noiseFromSeed, seedFromId } from './seed';
import type { RGB, SurfaceStyle, Vec4 } from './meshSink';

export type { RGB, Vec4 };

/** Style data shared by all faces of one building. */
export interface BuildingStyle {
  /** Index of the building in the input array (triangleOwner value). */
  owner: number;
  archetype: Archetype;
  archetypeId: number;
  floorHeight: number;
  groundFloorHeight: number;
  seed: number;
  flags: number;
  /** 0..1 cornice / trim strength hint for the facade shader. */
  trimIntensity: number;
  /** aFace.w detail hint for non-roof faces. */
  detailScale: number;
  /** Emit decorative geometry (ground band split, parapets, ...). */
  detail: boolean;
  /** aStyle vector (archetype id, floor height, ground floor height, seed). */
  style: Vec4;
  /** sRGB facade base colour. */
  baseColor: RGB;
  /** sRGB trim colour (parapet, cornice bands). */
  trimColor: RGB;
  /** Parapet height in metres for flat roofs. */
  parapetHeight: number;
}

export const SURFACE_DETAIL = {
  /** Default aFace.w multiplier when the caller does not override it. */
  defaultScale: 1,
} as const;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Convert a hex string to sRGB 0..1 (NOT linearised — shader does that). */
export function srgbFromHex(hex: string): RGB {
  const { r, g, b } = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

/** Sanitise the caller supplied detail scale. */
export function sanitiseDetailScale(scale: number | undefined): number {
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return SURFACE_DETAIL.defaultScale;
  return clamp(scale, 0.01, 8);
}

/** Roof base colour for a roof shape, sRGB. */
export function roofColorFor(shape: RoofShape, seed: number): RGB {
  const paletteShape: RoofShape = shape === 'complex' ? 'flat' : shape;
  return srgbFromHex(pickRoofColor(paletteShape, seed));
}

/** Build the style context for one building. */
export function styleForBuilding(
  building: BuildingFeature,
  owner: number,
  detail: boolean,
  detailScale: number,
): BuildingStyle {
  const preset = presetFor(building.archetype);
  const seed = seedFromId(building.id);
  const baseHex = pickFacadeColor(building.archetype, seed);
  const style: Vec4 = [
    ARCHETYPE_ID[building.archetype] ?? ARCHETYPE_ID.small,
    preset.floorHeight,
    preset.groundFloorHeight,
    seed,
  ];
  return {
    owner,
    archetype: building.archetype,
    archetypeId: style[0],
    floorHeight: preset.floorHeight,
    groundFloorHeight: preset.groundFloorHeight,
    seed,
    flags: preset.flags,
    trimIntensity: clamp(preset.corniceHeight / 1.1, 0, 1),
    detailScale,
    detail,
    style,
    baseColor: srgbFromHex(baseHex),
    trimColor: srgbFromHex(trimColorFor(baseHex)),
    parapetHeight: 0.26 + 0.1 * noiseFromSeed(seed, 3),
  };
}

/**
 * Style variant for elevated building:part volumes: aStyle.z = -1 tells the
 * facade shader "no ground-floor treatment" so no plinth/shopfront is painted
 * 10 m up on a rooftop part. (Agreed with the facades module.)
 */
export function withNoGroundBand(style: BuildingStyle): BuildingStyle {
  return {
    ...style,
    style: [style.style[0], style.style[1], -1, style.style[3]],
  };
}

/** Assemble the complete vertex attribute payload for one surface. */
export function makeSurface(
  style: BuildingStyle,
  kind: number,
  color: RGB,
  detailW: number,
): SurfaceStyle {
  return {
    owner: style.owner,
    color,
    style: style.style,
    face: [kind, style.flags, style.trimIntensity, detailW],
  };
}
