/**
 * Time-of-day palette blending.
 *
 * `TIME_OF_DAY_PRESETS` (owned by the art-direction module) defines the look at
 * six moments of the day. The renderer blends between them with a smoothstep so
 * scrubbing the time slider never snaps, and exposes the blended colours in the
 * linear working colour space used by the lights.
 */

import * as THREE from 'three';
import {
  TIME_OF_DAY_PRESETS,
  hexToRgb,
  type Hex,
  type TimeOfDayPreset,
} from '../materials/palette';

export interface BlendedLook {
  /** Dominant preset key (for debugging / stats). */
  key: string;
  hours: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  fogColor: THREE.Color;
  /** sRGB hex strings, for shaders / clear colours that want raw sRGB. */
  sunHex: Hex;
  skyHex: Hex;
  fogHex: Hex;
  fogNear: number;
  fogFar: number;
  shadowOpacity: number;
  nightFactor: number;
}

interface CachedPreset {
  preset: TimeOfDayPreset;
  sun: THREE.Color;
  ambient: THREE.Color;
  sky: THREE.Color;
  ground: THREE.Color;
  fog: THREE.Color;
}

const PRESETS: CachedPreset[] = TIME_OF_DAY_PRESETS.map((preset) => ({
  preset,
  sun: hexToColor(preset.sunColor),
  ambient: hexToColor(preset.ambientColor),
  sky: hexToColor(preset.skyColor),
  ground: hexToColor(preset.groundColor),
  fog: hexToColor(preset.fogColor),
})).sort((a, b) => a.preset.hours - b.preset.hours);

/** sRGB hex -> linear working-space THREE.Color. */
export function hexToColor(hex: Hex): THREE.Color {
  const { r, g, b } = hexToRgb(hex);
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

/** Linear THREE.Color -> sRGB hex string. */
export function colorToHex(color: THREE.Color): Hex {
  return `#${color.getHexString(THREE.SRGBColorSpace)}`;
}

function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function normalizeHours(hours: number): number {
  if (!Number.isFinite(hours)) return 13;
  let h = hours % 24;
  if (h < 0) h += 24;
  return h;
}

/**
 * Sample the blended look for a local clock hour (0..24).
 * Returns a fresh object: callers may keep it, nothing is shared except colours
 * are freshly allocated each call (setTimeOfDay is an interactive-rate call).
 */
export function sampleLook(hoursInput: number): BlendedLook {
  const hours = normalizeHours(hoursInput);
  const presetHours = PRESETS.map((entry) => entry.preset.hours);

  // The preset list is cyclic: 23:00 blends into 05:30 of the next day.
  const wrappedHours = hours < presetHours[0] ? hours + 24 : hours;
  let index = PRESETS.length - 1;
  for (let i = 0; i < PRESETS.length; i += 1) {
    if (presetHours[i] <= wrappedHours) index = i;
  }
  const from = PRESETS[index];
  const to = PRESETS[(index + 1) % PRESETS.length];
  const fromHours = from.preset.hours;
  const toHours =
    index + 1 < PRESETS.length ? to.preset.hours : PRESETS[0].preset.hours + 24;
  const span = Math.max(toHours - fromHours, 1e-6);
  const t = smoothstep((wrappedHours - fromHours) / span);

  const sunColor = new THREE.Color().lerpColors(from.sun, to.sun, t);
  const ambientColor = new THREE.Color().lerpColors(from.ambient, to.ambient, t);
  const skyColor = new THREE.Color().lerpColors(from.sky, to.sky, t);
  const groundColor = new THREE.Color().lerpColors(from.ground, to.ground, t);
  const fogColor = new THREE.Color().lerpColors(from.fog, to.fog, t);

  return {
    key: t < 0.5 ? from.preset.key : to.preset.key,
    hours,
    sunColor,
    sunIntensity: lerp(from.preset.sunIntensity, to.preset.sunIntensity, t),
    ambientColor,
    ambientIntensity: lerp(from.preset.ambientIntensity, to.preset.ambientIntensity, t),
    skyColor,
    groundColor,
    fogColor,
    sunHex: colorToHex(sunColor),
    skyHex: colorToHex(skyColor),
    fogHex: colorToHex(fogColor),
    fogNear: lerp(from.preset.fogNear, to.preset.fogNear, t),
    fogFar: lerp(from.preset.fogFar, to.preset.fogFar, t),
    shadowOpacity: lerp(from.preset.shadowOpacity, to.preset.shadowOpacity, t),
    nightFactor: lerp(from.preset.nightFactor, to.preset.nightFactor, t),
  };
}
