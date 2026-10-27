/**
 * Isometric Minsk — pixel-art palette and colour-quantisation helpers.
 *
 * This module is deliberately PURE: it imports nothing (not even Three.js) so
 * that both the facade material (which quantises its own output in the
 * fragment shader) and the renderer's post-processing pass (which quantises the
 * whole frame) can share one canonical palette without pulling scene code into
 * each other's modules.
 *
 * Ownership: facades / art-direction module. Keep this file data + pure
 * functions only; no canvas / WebGL / DOM references.
 *
 * Colour-space convention: every hex value in this module is **display sRGB**
 * (what the player sees after output encoding). `hexToLinearRgb` /
 * `paletteToLinearFloat32` are provided for code that needs lighting-space
 * values; the facade shader quantises *after* the sRGB output conversion, so it
 * uploads the raw sRGB values via `paletteToFloat32`.
 */

export type Hex = string;

/** sRGB colour, integer channels 0..255. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** sRGB colour, float channels 0..1. */
export interface RgbUnit {
  r: number;
  g: number;
  b: number;
}

/** Linear-light colour, float channels 0..1. */
export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

/**
 * The canonical pixel-art palette.
 *
 * Sized to stay readable at a 320-420 px tall internal resolution: a handful of
 * dark silhouette tones, two asphalt greys, a cool concrete ramp for panel /
 * Khrushchev blocks, a warm plaster ramp for Stalinist / historic buildings,
 * roof browns, trim stone, park greens, river blues, warm lamp light and dark
 * window glass. Every hue is slightly desaturated so that shadows and
 * silhouettes read before saturation does.
 *
 * Ordering is grouped by material family: keep related shades adjacent so
 * ordered-quantisation / ramp helpers can exploit it.
 */
export const PIXEL_PALETTE: Hex[] = [
  // deep shadow / silhouette
  '#191d23',
  '#242b33',
  // cool shade (panel walls, asphalt in shadow)
  '#39434b',
  '#4d5860',
  // asphalt / pavement
  '#5b636b',
  '#6d757c',
  // concrete / panel ramps (cool, monotonous)
  '#848c8e',
  '#989e9e',
  '#adb2af',
  '#c1c5bf',
  // light trim stone / cornices
  '#d6cfbf',
  '#ece6d6',
  // warm plaster ramp (Stalinist ensembles, civic)
  '#ab9070',
  '#bfa585',
  '#d3ba99',
  '#e3cfae',
  // historic plaster / brick
  '#a1775c',
  '#bc9477',
  // pitched-roof browns
  '#6b4c3d',
  '#8a634b',
  // park / forest greens
  '#4f6b3d',
  '#64814a',
  '#7e9857',
  // water
  '#40637c',
  '#587e96',
  // warm lit windows (night)
  '#e2bf6e',
  '#eed28d',
  '#f6e4b0',
  // dark window glass
  '#333f47',
  '#44535b',
];

/**
 * Number of entries in {@link PIXEL_PALETTE}. The facade shader uses this as a
 * compile-time array size, so the palette length is part of the shader
 * interface: if you edit the palette, rebuild is automatic but the GLSL
 * `uPalette` array length follows this constant.
 */
export const PIXEL_PALETTE_SIZE = PIXEL_PALETTE.length;

/** Default posterisation levels per sRGB channel for cheap, non-palette quantisation. */
export const QUANTISE_LEVELS = 14;

/**
 * 4x4 ordered-dither (Bayer) matrix, normalised to 0..1. The renderer post pass
 * can add `(threshold - 0.5) * amount` to a colour before snapping it to the
 * palette to break up banding instead of hard posterising.
 */
export const BAYER_4X4: number[] = [
  0 / 16, 8 / 16, 2 / 16, 10 / 16,
  12 / 16, 4 / 16, 14 / 16, 6 / 16,
  3 / 16, 11 / 16, 1 / 16, 9 / 16,
  15 / 16, 7 / 16, 13 / 16, 5 / 16,
];

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** True when `value` is a `#rgb` or `#rrggbb` string. */
export function isHexColor(value: unknown): value is Hex {
  return typeof value === 'string' && HEX_PATTERN.test(value);
}

/** Parse a hex colour into integer sRGB channels. Accepts `#rgb` and `#rrggbb`. */
export function hexToRgb(hex: Hex): Rgb {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Build a `#rrggbb` string from integer sRGB channels (clamped). */
export function rgbToHex(r: number, g: number, b: number): Hex {
  const to = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Parse a hex colour into float sRGB channels 0..1 (no transfer function). */
export function hexToRgbUnit(hex: Hex): RgbUnit {
  const { r, g, b } = hexToRgb(hex);
  return { r: r / 255, g: g / 255, b: b / 255 };
}

/** sRGB-channel (0..1) -> linear-light channel (0..1). */
export function srgbChannelToLinear(value: number): number {
  const v = clamp(value, 0, 1);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear-light channel (0..1) -> sRGB-channel (0..1). */
export function linearChannelToSrgb(value: number): number {
  const v = clamp(value, 0, 1);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Parse a hex colour into linear-light channels (what Three.js lighting expects). */
export function hexToLinearRgb(hex: Hex): LinearRgb {
  const c = hexToRgbUnit(hex);
  return {
    r: srgbChannelToLinear(c.r),
    g: srgbChannelToLinear(c.g),
    b: srgbChannelToLinear(c.b),
  };
}

/** Linear-light palette, e.g. for background / fog / light colours consumed as linear. */
export function paletteToLinearFloat32(colors: readonly Hex[] = PIXEL_PALETTE): Float32Array {
  const out = new Float32Array(colors.length * 3);
  for (let i = 0; i < colors.length; i++) {
    const c = hexToLinearRgb(colors[i]);
    out[i * 3] = c.r;
    out[i * 3 + 1] = c.g;
    out[i * 3 + 2] = c.b;
  }
  return out;
}

/** Raw sRGB palette as a flat `vec3[]` float array for shader uniforms. */
export function paletteToFloat32(colors: readonly Hex[] = PIXEL_PALETTE): Float32Array {
  const out = new Float32Array(colors.length * 3);
  for (let i = 0; i < colors.length; i++) {
    const c = hexToRgb(colors[i]);
    out[i * 3] = c.r / 255;
    out[i * 3 + 1] = c.g / 255;
    out[i * 3 + 2] = c.b / 255;
  }
  return out;
}

/** Blend two hex colours in sRGB space. `t` is clamped to 0..1. */
export function mixHex(a: Hex, b: Hex, t: number): Hex {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp(t, 0, 1);
  return rgbToHex(
    ca.r + (cb.r - ca.r) * k,
    ca.g + (cb.g - ca.g) * k,
    ca.b + (cb.b - ca.b) * k,
  );
}

/** Multiply a hex colour's channels (factor > 1 brightens, < 1 darkens). */
export function scaleHex(hex: Hex, factor: number): Hex {
  const c = hexToRgb(hex);
  return rgbToHex(c.r * factor, c.g * factor, c.b * factor);
}

/**
 * Index of the nearest palette entry. Distance is a weighted RGB distance with
 * a mild luma bias, so dark silhouette colours win against saturated ones for
 * shadowed pixels (important for readable city silhouettes).
 */
export function nearestPaletteIndex(hex: Hex, palette: readonly Hex[] = PIXEL_PALETTE): number {
  return nearestIndexForRgb(hexToRgb(hex), palette);
}

/** Hex of the nearest palette entry. */
export function nearestPaletteHex(hex: Hex, palette: readonly Hex[] = PIXEL_PALETTE): Hex {
  return palette[nearestPaletteIndex(hex, palette)] ?? hex;
}

/**
 * Snap a colour to the nearest palette entry, then blend back toward the
 * original by `mixAmount` (1 = fully quantised, 0 = unchanged).
 */
export function quantiseHex(
  hex: Hex,
  palette: readonly Hex[] = PIXEL_PALETTE,
  mixAmount = 1,
): Hex {
  const target = palette[nearestPaletteIndex(hex, palette)] ?? hex;
  return mixHex(hex, target, clamp(mixAmount, 0, 1));
}

/** Posterise a single 0..1 channel to `levels` steps. */
export function posteriseChannel(value: number, levels = QUANTISE_LEVELS): number {
  const n = Math.max(1, Math.round(levels));
  const v = clamp(value, 0, 1);
  if (n <= 1) return v;
  return Math.round(v * (n - 1)) / (n - 1);
}

/** Posterise a hex colour to `levels` steps per channel (cheap non-palette quantisation). */
export function posteriseHex(hex: Hex, levels = QUANTISE_LEVELS): Hex {
  const c = hexToRgbUnit(hex);
  return rgbToHex(
    posteriseChannel(c.r, levels) * 255,
    posteriseChannel(c.g, levels) * 255,
    posteriseChannel(c.b, levels) * 255,
  );
}

/** Ordered-dither threshold 0..1 for a pixel coordinate (Bayer 4x4). */
export function ditherThreshold(x: number, y: number): number {
  const px = ((Math.floor(x) % 4) + 4) % 4;
  const py = ((Math.floor(y) % 4) + 4) % 4;
  return BAYER_4X4[py * 4 + px];
}

/** Dither a colour around a quantisation step before snapping (amount 0..1). */
export function ditherHex(hex: Hex, x: number, y: number, amount = 0.5): Hex {
  const c = hexToRgbUnit(hex);
  const bias = (ditherThreshold(x, y) - 0.5) * (amount / 255) * 255 * 0.02;
  // Bias in channel units: a full dither amount moves at most ~5 8-bit levels.
  const shift = bias * 5;
  return rgbToHex(
    srgbChannelToLinear(c.r) * 0 + c.r * 255 + shift,
    c.g * 255 + shift,
    c.b * 255 + shift,
  );
}

function nearestIndexForRgb(rgb: Rgb, palette: readonly Hex[]): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i++) {
    const c = hexToRgb(palette[i]);
    const dr = (rgb.r - c.r) / 255;
    const dg = (rgb.g - c.g) / 255;
    const db = (rgb.b - c.b) / 255;
    // Weight green slightly higher (perceived luminance) and blue lower.
    const dist = dr * dr * 0.9 + dg * dg * 1.15 + db * db * 0.8;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
