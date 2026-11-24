/**
 * Landmark pins: the DOM marker layer that mirrors the Warsaw IZO interaction
 * reference. Layout and hit testing are DOM-free so they can be tested here;
 * painting is a thin per-frame style update over the same result.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hitLandmarkPin,
  landmarkPinIsMajor,
  layoutLandmarkPins,
  MAX_PINS,
  PIN_HEIGHT,
  PIN_HIT_RADIUS,
  PIN_LIFT,
  PIN_WIDTH,
  pinIconDataUrl,
  type LandmarkPinAnchor,
} from '../../../src/engine/landmarks/landmarkPins';
import type { LandmarkMeta } from '../../../src/engine/landmarks/landmarkLayer';

const PAYLOAD = resolve(__dirname, '../../../public/data/landmarks');

function anchor(slug: string, x: number, y: number, major = true): LandmarkPinAnchor {
  return { slug, label: slug, x, y, major };
}

describe('landmark pin marker', () => {
  it('uses the 9×11 pixel marker at the reference 2× scale', () => {
    expect(PIN_WIDTH).toBe(18);
    expect(PIN_HEIGHT).toBe(22);
    const url = pinIconDataUrl();
    expect(url.startsWith('url("data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(url.slice('url("data:image/svg+xml,'.length, -2));
    expect(svg).toContain('viewBox="0 0 9 11"');
    expect(svg).toContain(`width="${PIN_WIDTH}" height="${PIN_HEIGHT}"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
    // Gold body with a black outline and the dark glyph, as in the reference.
    expect(svg).toContain('#e4b54a');
    expect(svg).toContain('#000000');
    expect(url).toBe(pinIconDataUrl());
  });

  it('marks major landmarks by height or footprint span (reference rule)', () => {
    expect(landmarkPinIsMajor({ heightM: 39.9, extent: [-10, -10, 10, 10] })).toBe(false);
    expect(landmarkPinIsMajor({ heightM: 40, extent: [-10, -10, 10, 10] })).toBe(true);
    expect(landmarkPinIsMajor({ heightM: 12, extent: [-90, -10, 90, 10] })).toBe(true);
    expect(landmarkPinIsMajor({ heightM: 12, extent: [-89.9, -10, 89.9, 10] })).toBe(false);
  });
});

describe('landmark pin layout', () => {
  it('anchors the pin tip at the projected model top', () => {
    const pins = layoutLandmarkPins([anchor('a', 100, 200), anchor('b', 400, 300)], {
      width: 800,
      height: 600,
    });
    expect(pins).toHaveLength(2);
    const a = pins.find((pin) => pin.slug === 'a')!;
    expect(a.left).toBe(100 - PIN_WIDTH / 2);
    expect(a.top).toBe(200 - PIN_LIFT - PIN_HEIGHT);
    expect(a.hitX).toBe(100);
    expect(a.hitY).toBe(200 - PIN_HEIGHT / 2);
  });

  it('spreads an overlapping group into one row around its mean x', () => {
    const pins = layoutLandmarkPins(
      [anchor('a', 100, 200), anchor('b', 104, 202), anchor('c', 98, 201)],
      { width: 800, height: 600 },
    );
    expect(pins).toHaveLength(3);
    expect(new Set(pins.map((pin) => pin.y))).toEqual(new Set([200]));
    const xs = pins.map((pin) => pin.x).sort((left, right) => left - right);
    expect(xs[1] - xs[0]).toBe(PIN_WIDTH + 2);
    expect(xs[2] - xs[1]).toBe(PIN_WIDTH + 2);
    const mean = (100 + 104 + 98) / 3;
    expect(Math.abs((xs[0] + xs[1] + xs[2]) / 3 - mean)).toBeLessThanOrEqual(1);
    // The group keeps the topmost anchor's y, so the row stays above the models.
    expect(pins.every((pin) => pin.top === 200 - PIN_LIFT - PIN_HEIGHT)).toBe(true);
  });

  it('leaves well-separated pins untouched', () => {
    const pins = layoutLandmarkPins([anchor('a', 100, 200), anchor('b', 160, 200)], {
      width: 800,
      height: 600,
    });
    expect(pins.map((pin) => pin.x).sort((left, right) => left - right)).toEqual([100, 160]);
  });

  it('drops pins outside the viewport and degenerate sizes', () => {
    expect(
      layoutLandmarkPins(
        [anchor('left', -30, 100), anchor('top', 100, 0), anchor('right', 900, 100)],
        { width: 800, height: 600 },
      ),
    ).toEqual([]);
    expect(layoutLandmarkPins([anchor('a', 0, 100)], { width: 0, height: 0 })).toEqual([]);
  });

  it('caps the marker count but keeps every major landmark', () => {
    const anchors: LandmarkPinAnchor[] = [];
    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 10; col += 1) {
        const index = row * 10 + col;
        anchors.push(anchor(`p${index}`, 100 + col * 100, 100 + row * 100, index % 10 === 0));
      }
    }
    const pins = layoutLandmarkPins(anchors, { width: 1200, height: 1200 });
    expect(pins).toHaveLength(MAX_PINS);
    expect(pins.filter((pin) => pin.major)).toHaveLength(10);
  });
});

describe('landmark pin hit test', () => {
  const pins = layoutLandmarkPins([anchor('a', 100, 200), anchor('b', 300, 200)], {
    width: 800,
    height: 600,
  });

  it('accepts a click inside the 20 px marker radius', () => {
    expect(hitLandmarkPin(pins, 100, 200 - PIN_HEIGHT / 2)).toBe('a');
    expect(hitLandmarkPin(pins, 100 + PIN_HIT_RADIUS, 200 - PIN_HEIGHT / 2)).toBe('a');
  });

  it('rejects a click just outside the radius and empty space', () => {
    expect(hitLandmarkPin(pins, 100 + PIN_HIT_RADIUS + 1, 200 - PIN_HEIGHT / 2)).toBeNull();
    expect(hitLandmarkPin(pins, 200, 100)).toBeNull();
    expect(hitLandmarkPin([], 100, 100)).toBeNull();
  });

  it('picks the nearest marker when two hit radii overlap', () => {
    const near = layoutLandmarkPins([anchor('a', 100, 200), anchor('b', 130, 200)], {
      width: 800,
      height: 600,
    });
    expect(hitLandmarkPin(near, 122, 200 - PIN_HEIGHT / 2)).toBe('b');
    expect(hitLandmarkPin(near, 108, 200 - PIN_HEIGHT / 2)).toBe('a');
  });
});

describe('baked landmark pins', () => {
  it('has one placeable anchor per baked landmark, within the pin cap', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(PAYLOAD, 'manifest.json'), 'utf8'),
    ) as { landmarks: LandmarkMeta[] };
    expect(manifest.landmarks.length).toBeGreaterThan(0);
    expect(manifest.landmarks.length).toBeLessThanOrEqual(MAX_PINS);
    for (const meta of manifest.landmarks) {
      expect(Number.isFinite(meta.x + meta.y + meta.heightM), meta.slug).toBe(true);
      expect(meta.extent, meta.slug).toHaveLength(4);
      const [minE, minN, maxE, maxN] = meta.extent;
      expect(maxE, meta.slug).toBeGreaterThan(minE);
      expect(maxN, meta.slug).toBeGreaterThan(minN);
    }
  });
});
