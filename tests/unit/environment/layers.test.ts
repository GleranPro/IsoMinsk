import { describe, expect, it } from 'vitest';
import { GROUND_LAYER_Y } from '../../../src/shared/config';
import {
  ENV_LAYER_JITTER_LEVELS,
  ENV_LAYER_ORDER,
  ENV_LAYER_Y,
  LAYER_JITTER_STEP_M,
  BRIDGE_RAISE_M,
  DASH_MARKING_CLASSES,
  KERB_CLASSES,
  layerY,
  maxLayerY,
  roadTier,
  surfaceTier,
} from '../../../src/city/environment/envLayers';
import type { SurfaceKind } from '../../../src/shared/types';

describe('environment layer heights', () => {
  it('is strictly increasing in ENV_LAYER_ORDER', () => {
    for (let i = 1; i < ENV_LAYER_ORDER.length; i++) {
      const previous = ENV_LAYER_Y[ENV_LAYER_ORDER[i - 1]];
      const current = ENV_LAYER_Y[ENV_LAYER_ORDER[i]];
      expect(current, `${ENV_LAYER_ORDER[i]} must be above ${ENV_LAYER_ORDER[i - 1]}`).toBeGreaterThan(
        previous,
      );
    }
  });

  it('keeps jittered polygons of each layer strictly below the next layer', () => {
    for (let i = 0; i < ENV_LAYER_ORDER.length - 1; i++) {
      const key = ENV_LAYER_ORDER[i];
      const next = ENV_LAYER_ORDER[i + 1];
      // Well above the isometric depth resolution (~0.7 mm for near=1/far=12000).
      expect(ENV_LAYER_Y[next] - maxLayerY(key)).toBeGreaterThanOrEqual(0.002);
    }
  });

  it('uses the shared GROUND_LAYER_Y values for every shared layer', () => {
    expect(ENV_LAYER_Y.base).toBe(GROUND_LAYER_Y.base);
    expect(ENV_LAYER_Y.landuse).toBe(GROUND_LAYER_Y.landuse);
    expect(ENV_LAYER_Y.grass).toBe(GROUND_LAYER_Y.grass);
    expect(ENV_LAYER_Y.water).toBe(GROUND_LAYER_Y.water);
    expect(ENV_LAYER_Y.sidewalk).toBe(GROUND_LAYER_Y.sidewalk);
    expect(ENV_LAYER_Y.road).toBe(GROUND_LAYER_Y.road);
    expect(ENV_LAYER_Y.markings).toBe(GROUND_LAYER_Y.markings);
    // Local railway offsets must sit between the shared layers.
    expect(ENV_LAYER_Y.railBallast).toBeGreaterThan(GROUND_LAYER_Y.sidewalk);
    expect(ENV_LAYER_Y.railBallast).toBeLessThan(GROUND_LAYER_Y.road);
    expect(ENV_LAYER_Y.railTrack).toBeGreaterThan(GROUND_LAYER_Y.markings);
  });

  it('jitters deterministically inside the layer band', () => {
    for (const key of ENV_LAYER_ORDER) {
      const levels = ENV_LAYER_JITTER_LEVELS[key];
      const base = ENV_LAYER_Y[key];
      for (let index = 0; index < levels * 3; index++) {
        const y = layerY(key, index);
        expect(y).toBeGreaterThanOrEqual(base - 1e-12);
        expect(y).toBeLessThanOrEqual(maxLayerY(key) + 1e-12);
        expect(layerY(key, index)).toBe(y); // deterministic
      }
      // Jitter wraps deterministically.
      expect(layerY(key, levels + 3)).toBeCloseTo(layerY(key, 3), 12);
    }
  });

  it('uses a jitter step comfortably above depth resolution', () => {
    expect(LAYER_JITTER_STEP_M).toBeGreaterThan(0.001);
  });

  it('raises bridges well clear of the ground layers', () => {
    expect(BRIDGE_RAISE_M).toBeGreaterThan(1);
    expect(ENV_LAYER_Y.road + BRIDGE_RAISE_M).toBeGreaterThan(1);
  });
});

describe('surface tier classification', () => {
  it('maps water kinds to the water layer', () => {
    expect(surfaceTier('water')).toBe('water');
    expect(surfaceTier('river')).toBe('water');
  });

  it('maps vegetation kinds to the grass layer', () => {
    for (const kind of ['grass', 'park', 'forest', 'scrub'] as SurfaceKind[]) {
      expect(surfaceTier(kind)).toBe('grass');
    }
  });

  it('maps man-made landuse kinds to the landuse layer', () => {
    for (const kind of [
      'plaza',
      'residential',
      'industrial',
      'commercial',
      'construction',
      'pitch',
      'cemetery',
      'railway',
      'sand',
      'unknown',
    ] as SurfaceKind[]) {
      expect(surfaceTier(kind)).toBe('landuse');
    }
  });

  it('handles undefined kinds defensively', () => {
    expect(surfaceTier(undefined)).toBe('landuse');
  });
});

describe('road tier classification', () => {
  it('classifies rail, footways and drivable roads', () => {
    expect(roadTier({ kind: 'rail', class: 'unknown' })).toBe('rail');
    expect(roadTier({ kind: 'footway', class: 'footway' })).toBe('pavement');
    expect(roadTier({ kind: 'road', class: 'footway' })).toBe('pavement');
    expect(roadTier({ kind: 'road', class: 'primary' })).toBe('road');
    expect(roadTier({ kind: 'road', class: 'residential' })).toBe('road');
  });

  it('only paints dashes on avenue-class roads and kerbs on driveable classes', () => {
    expect(DASH_MARKING_CLASSES.has('primary')).toBe(true);
    expect(DASH_MARKING_CLASSES.has('secondary')).toBe(true);
    expect(DASH_MARKING_CLASSES.has('residential')).toBe(false);
    expect(DASH_MARKING_CLASSES.has('footway')).toBe(false);
    expect(KERB_CLASSES.has('residential')).toBe(true);
    expect(KERB_CLASSES.has('footway')).toBe(false);
  });
});
