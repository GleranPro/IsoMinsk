/**
 * Art-direction palette tests: material palette (src/engine/materials/palette.ts)
 * and the pure quantisation helper module (src/engine/postprocess/palette.ts).
 *
 * No GPU / DOM: the quantisation module is deliberately dependency-free so the
 * facade material and the renderer's post-processing pass share one palette.
 */

import { describe, expect, it } from 'vitest';
import {
  ARCHETYPE_COLORS,
  ENV_PALETTE,
  FACADE_GROUND_COLOR,
  FACADE_TRIM_COLOR,
  ROAD_PALETTE,
  ROAD_WIDTH_M,
  ROOF_COLORS,
  SIDEWALK_COLOR,
  TIME_OF_DAY_PRESETS,
  TREE_COLORS,
  TREE_TRUNK_COLOR,
  WINDOW_COLORS,
  hexToRgb,
  mixHex,
  pickFacadeColor,
  pickRoofColor,
  rgbToHex,
  shadeHex,
  surfaceColor,
  trimColorFor,
} from '../../../src/engine/materials/palette';
import { ARCHETYPE_BY_ID } from '../../../src/shared/geometry';
import type { Archetype, RoofShape, RoadClass, SurfaceKind } from '../../../src/shared/types';
import {
  BAYER_4X4,
  PIXEL_PALETTE,
  PIXEL_PALETTE_SIZE,
  QUANTISE_LEVELS,
  ditherThreshold,
  hexToLinearRgb,
  hexToRgbUnit,
  isHexColor,
  linearChannelToSrgb,
  mixHex as mixHexPost,
  nearestPaletteHex,
  nearestPaletteIndex,
  paletteToFloat32,
  paletteToLinearFloat32,
  posteriseChannel,
  posteriseHex,
  quantiseHex,
  rgbToHex as rgbToHexPost,
  scaleHex,
  srgbChannelToLinear,
} from '../../../src/engine/postprocess/palette';

const ARCHETYPES = ARCHETYPE_BY_ID;
const ROOF_SHAPES: RoofShape[] = [
  'flat',
  'gabled',
  'hipped',
  'pyramidal',
  'skillion',
  'dome',
  'complex',
];
const ROAD_CLASSES = Object.keys(ROAD_PALETTE) as RoadClass[];
const SURFACE_KINDS: SurfaceKind[] = [
  'grass',
  'park',
  'forest',
  'scrub',
  'water',
  'river',
  'sand',
  'pitch',
  'cemetery',
  'railway',
  'plaza',
  'residential',
  'industrial',
  'commercial',
  'construction',
  'unknown',
];

describe('material palette', () => {
  it('uses valid hex colours everywhere', () => {
    for (const value of Object.values(ENV_PALETTE)) expect(isHexColor(value)).toBe(true);
    for (const value of Object.values(ROAD_PALETTE)) expect(isHexColor(value)).toBe(true);
    for (const family of Object.values(ROOF_COLORS)) {
      for (const value of family) expect(isHexColor(value)).toBe(true);
    }
    for (const archetype of ARCHETYPES) {
      for (const value of ARCHETYPE_COLORS[archetype]) expect(isHexColor(value)).toBe(true);
    }
    for (const value of Object.values(WINDOW_COLORS)) expect(isHexColor(value)).toBe(true);
    for (const value of TREE_COLORS) expect(isHexColor(value)).toBe(true);
    expect(isHexColor(TREE_TRUNK_COLOR)).toBe(true);
    expect(isHexColor(SIDEWALK_COLOR)).toBe(true);
    expect(isHexColor(FACADE_TRIM_COLOR)).toBe(true);
    expect(isHexColor(FACADE_GROUND_COLOR)).toBe(true);
  });

  it('gives every archetype a facade palette of at least three choices', () => {
    for (const archetype of ARCHETYPES) {
      expect(ARCHETYPE_COLORS[archetype].length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the traffic surface palette darker than the pavement palette', () => {
    const luminance = (hex: string): number => {
      const { r, g, b } = hexToRgb(hex);
      return (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    };
    const asphalt = ROAD_CLASSES.filter((c) =>
      ['motorway', 'trunk', 'primary', 'secondary', 'residential', 'unknown'].includes(c),
    ).map((c) => luminance(ROAD_PALETTE[c]));
    expect(Math.max(...asphalt)).toBeLessThan(luminance(SIDEWALK_COLOR));
  });

  it('has positive road widths for every class', () => {
    for (const roadClass of ROAD_CLASSES) {
      expect(ROAD_WIDTH_M[roadClass]).toBeGreaterThan(0);
    }
  });

  it('pickRoofColor is deterministic and returns a family colour', () => {
    for (const shape of ROOF_SHAPES) {
      const first = pickRoofColor(shape, 0.42);
      expect(pickRoofColor(shape, 0.42)).toBe(first);
      expect(isHexColor(first)).toBe(true);
    }
  });

  it('pickFacadeColor returns a colour from the archetype palette', () => {
    for (const archetype of ARCHETYPES) {
      for (const seed of [0, 0.13, 0.5, 0.9]) {
        const color = pickFacadeColor(archetype, seed);
        expect(ARCHETYPE_COLORS[archetype]).toContain(color);
        expect(isHexColor(color)).toBe(true);
      }
    }
  });

  it('pickFacadeColor varies between building seeds', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) seen.add(pickFacadeColor('stalin', i / 24));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('surfaceColor covers every surface kind', () => {
    for (const kind of SURFACE_KINDS) {
      expect(isHexColor(surfaceColor(kind))).toBe(true);
    }
  });

  it('hex/shade/mix helpers round-trip', () => {
    const rgb = hexToRgb('#4a6f88');
    expect(rgb).toEqual({ r: 74, g: 111, b: 136 });
    expect(rgbToHex(rgb.r, rgb.g, rgb.b)).toBe('#4a6f88');
    expect(shadeHex('#808080', 0)).toBe('#808080');
    expect(shadeHex('#808080', 1)).toBe('#ffffff');
    expect(shadeHex('#808080', -1)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('trim colours are lighter than the facade colours they decorate', () => {
    const luminance = (hex: string): number => {
      const { r, g, b } = hexToRgb(hex);
      return r * 0.299 + g * 0.587 + b * 0.114;
    };
    for (const base of ['#b3b6b4', '#a8795d', '#c8b595', '#84867f']) {
      expect(luminance(trimColorFor(base))).toBeGreaterThan(luminance(base) * 0.95);
      expect(isHexColor(trimColorFor(base))).toBe(true);
    }
  });

  it('time-of-day presets are complete and valid', () => {
    expect(TIME_OF_DAY_PRESETS.length).toBeGreaterThanOrEqual(4);
    for (const preset of TIME_OF_DAY_PRESETS) {
      expect(preset.hours).toBeGreaterThanOrEqual(0);
      expect(preset.hours).toBeLessThanOrEqual(24);
      for (const key of [
        'sunColor',
        'ambientColor',
        'skyColor',
        'groundColor',
        'fogColor',
      ] as const) {
        expect(isHexColor(preset[key])).toBe(true);
      }
      expect(preset.sunIntensity).toBeGreaterThan(0);
      expect(preset.ambientIntensity).toBeGreaterThan(0);
      expect(preset.nightFactor).toBeGreaterThanOrEqual(0);
      expect(preset.nightFactor).toBeLessThanOrEqual(1);
      expect(preset.fogFar).toBeGreaterThan(preset.fogNear);
    }
    // The palette must include a real night preset for lit windows to matter.
    expect(TIME_OF_DAY_PRESETS.some((preset) => preset.nightFactor === 1)).toBe(true);
  });
});

describe('postprocess palette helpers', () => {
  it('ships the canonical pixel palette', () => {
    expect(PIXEL_PALETTE.length).toBeGreaterThan(12);
    expect(PIXEL_PALETTE_SIZE).toBe(PIXEL_PALETTE.length);
    for (const color of PIXEL_PALETTE) expect(isHexColor(color)).toBe(true);
  });

  it('parses hex colours with and without the leading hash', () => {
    expect(hexToRgbUnit('#ffffff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexToRgbUnit('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgbUnit('808080')).toEqual({ r: 128 / 255, g: 128 / 255, b: 128 / 255 });
    expect(hexToRgbUnit('#fff')).toEqual({ r: 1, g: 1, b: 1 });
  });

  it('converts sRGB to linear light consistently', () => {
    expect(srgbChannelToLinear(0)).toBeCloseTo(0, 6);
    expect(srgbChannelToLinear(1)).toBeCloseTo(1, 6);
    expect(srgbChannelToLinear(0.5)).toBeCloseTo(0.214, 3);
    for (let i = 0; i <= 10; i++) {
      const v = i / 10;
      expect(linearChannelToSrgb(srgbChannelToLinear(v))).toBeCloseTo(v, 5);
    }
    const linear = hexToLinearRgb('#808080');
    expect(linear.r).toBeCloseTo(0.216, 3);
    expect(linear.r).toBeCloseTo(linear.g, 6);
    expect(linear.g).toBeCloseTo(linear.b, 6);
  });

  it('converts a palette to uniform-ready arrays', () => {
    const raw = paletteToFloat32(PIXEL_PALETTE);
    expect(raw.length).toBe(PIXEL_PALETTE.length * 3);
    for (const channel of raw) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
    const linear = paletteToLinearFloat32(PIXEL_PALETTE);
    expect(linear.length).toBe(PIXEL_PALETTE.length * 3);
    // Linear values must be <= their sRGB counterparts for display colours.
    for (let i = 0; i < raw.length; i++) expect(linear[i]).toBeLessThanOrEqual(raw[i] + 1e-6);
  });

  it('nearest-palette helpers return palette members', () => {
    for (const color of ['#b3b6b4', '#e8c877', '#4a6f88', '#123456', '#fefefe']) {
      const index = nearestPaletteIndex(color);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(PIXEL_PALETTE.length);
      expect(PIXEL_PALETTE).toContain(nearestPaletteHex(color));
    }
    // A palette colour must map to itself.
    for (const color of PIXEL_PALETTE) {
      expect(nearestPaletteHex(color)).toBe(color.toLowerCase());
    }
  });

  it('quantiseHex respects the mix amount and returns valid colours', () => {
    const base = '#b3b6b4';
    expect(quantiseHex(base, PIXEL_PALETTE, 0)).toBe(base);
    expect(quantiseHex(base, PIXEL_PALETTE, 1)).toBe(nearestPaletteHex(base));
    const half = quantiseHex(base, PIXEL_PALETTE, 0.5);
    expect(isHexColor(half)).toBe(true);
    expect(half).toBe(mixHexPost(base, nearestPaletteHex(base), 0.5));
  });

  it('posterisation clamps into range and quantises channels', () => {
    expect(posteriseChannel(0)).toBe(0);
    expect(posteriseChannel(1)).toBe(1);
    const levels = 4;
    const stepped = posteriseChannel(0.31, levels);
    expect(stepped).toBeCloseTo(1 / 3, 6);
    const hex = posteriseHex('#b3b6b4', 8);
    expect(isHexColor(hex)).toBe(true);
    expect(QUANTISE_LEVELS).toBeGreaterThanOrEqual(4);
  });

  it('mixes and scales hex colours', () => {
    expect(mixHexPost('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHexPost('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(isHexColor(scaleHex('#808080', 0.5))).toBe(true);
    expect(rgbToHexPost(255, 0, 0)).toBe('#ff0000');
  });

  it('ships a valid ordered dither matrix', () => {
    expect(BAYER_4X4.length).toBe(16);
    expect(new Set(BAYER_4X4).size).toBe(16);
    for (const value of BAYER_4X4) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        const threshold = ditherThreshold(x, y);
        expect(threshold).toBeGreaterThanOrEqual(0);
        expect(threshold).toBeLessThanOrEqual(1);
      }
    }
  });

  it('does not let the darkest tones dominate the palette', () => {
    // Acceptance criterion from the art review: a sunlit city palette must have
    // at most ~20% of its entries in the darkest quartile (< 64/255 luminance),
    // otherwise quantisation pulls mid-tones down into mud.
    const luminance = (hex: string): number => {
      const { r, g, b } = hexToRgbUnit(hex);
      return (r * 0.299 + g * 0.587 + b * 0.114) * 255;
    };
    const darkEntries = PIXEL_PALETTE.filter((hex) => luminance(hex) < 64).length;
    expect(darkEntries / PIXEL_PALETTE.length).toBeLessThanOrEqual(0.2);
    // And there must be real light values for sunlit facades/pavement.
    expect(PIXEL_PALETTE.filter((hex) => luminance(hex) > 190).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps sunlit Stalinist beige warm instead of snapping to near-white', () => {
    // What a sunlit beige Stalinist facade looks like before quantisation.
    const sunlitBeige = '#d6c6a6';
    const mapped = nearestPaletteHex(sunlitBeige);
    const { r, g, b } = hexToRgbUnit(mapped);
    expect(isHexColor(mapped)).toBe(true);
    expect(r).toBeGreaterThan(b); // warm, not neutral/blue
    const value = (r * 0.299 + g * 0.587 + b * 0.114) * 255;
    expect(value).toBeGreaterThan(175);
    expect(value).toBeLessThan(235);
    // Must not flatten to the near-white trim/off-white entries.
    expect(mapped).not.toBe('#f1ece0');
    expect(mapped).not.toBe('#e8e2d2');
  });

  it('keeps asphalt and pavement mid-tones in a readable output band', () => {
    const luminance = (hex: string): number => {
      const { r, g, b } = hexToRgbUnit(hex);
      return (r * 0.299 + g * 0.587 + b * 0.114) * 255;
    };
    const asphalt = nearestPaletteHex('#6e7278');
    const pavement = nearestPaletteHex('#a9a293');
    const asphaltLum = luminance(asphalt);
    const pavementLum = luminance(pavement);
    // Roads may not collapse into the darkest silhouette entries.
    expect(asphaltLum).toBeGreaterThan(60);
    expect(asphaltLum).toBeLessThan(140);
    // Sidewalk/plaza must stay clearly lighter than asphalt and darker than trim.
    expect(pavementLum).toBeGreaterThan(asphaltLum + 25);
    expect(pavementLum).toBeLessThan(235);
    // Grass and water keep distinct hues after quantisation.
    const grass = nearestPaletteHex('#7d9a52');
    const water = nearestPaletteHex('#6d95ab');
    const grassRgb = hexToRgbUnit(grass);
    const waterRgb = hexToRgbUnit(water);
    expect(grassRgb.g).toBeGreaterThan(grassRgb.b);
    expect(waterRgb.b).toBeGreaterThan(waterRgb.r);
  });
});
