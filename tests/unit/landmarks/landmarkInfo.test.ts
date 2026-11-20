/**
 * Landmark cards: every baked landmark must have a complete card, and the card
 * links must resolve to real OSM objects.
 */

import { describe, expect, it } from 'vitest';
import { PLACED_LANDMARKS, landmarkInfoSlug } from '../../../src/shared/landmarks';
import { LANDMARK_INFO, osmObjectUrl } from '../../../src/app/landmarkInfo';

describe('landmark cards', () => {
  it('has a complete card for every placed landmark', () => {
    for (const entry of PLACED_LANDMARKS) {
      const info = LANDMARK_INFO[entry.slug];
      expect(info, entry.slug).toBeDefined();
      expect(info.title.trim().length, entry.slug).toBeGreaterThan(3);
      expect(info.kind.trim().length, entry.slug).toBeGreaterThan(2);
      expect(info.description.length, entry.slug).toBeGreaterThan(40);
      expect(info.wiki, entry.slug).toMatch(/^https:\/\/ru\.wikipedia\.org\//);
    }
  });

  it('has no cards for landmarks that are not in the baked payload', () => {
    const placed = new Set(PLACED_LANDMARKS.map((entry) => entry.slug));
    for (const slug of Object.keys(LANDMARK_INFO)) {
      expect(placed.has(slug), slug).toBe(true);
    }
  });

  it('builds OSM object URLs from catalog ids', () => {
    expect(osmObjectUrl('w25387231')).toBe('https://www.openstreetmap.org/way/25387231');
    expect(osmObjectUrl('n462268066')).toBe('https://www.openstreetmap.org/node/462268066');
    expect(osmObjectUrl('r11788611')).toBe('https://www.openstreetmap.org/relation/11788611');
  });

  it('resolves only placed landmarks from the ?info= deep link', () => {
    expect(landmarkInfoSlug('?info=red-church')).toBe('red-church');
    expect(landmarkInfoSlug('?info=unknown-landmark')).toBeNull();
    expect(landmarkInfoSlug('')).toBeNull();
  });
});
