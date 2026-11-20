import { describe, expect, it } from 'vitest';
import {
  buildingUseFor,
  hasStrongStyleEvidence,
} from '../../../src/city/buildings/buildingUse';
import { squarePrismBuilding } from '../../fixtures/buildings';
import type { BuildingFeature } from '../../../src/shared/types';

function feature(tags: Record<string, string>, options: Partial<BuildingFeature> = {}): BuildingFeature {
  return { ...squarePrismBuilding(), ...options, tags };
}

describe('buildingUseFor', () => {
  it('detects churches and cathedrals from building, amenity, historic and religion tags', () => {
    expect(buildingUseFor(feature({ building: 'church' }))).toBe('religious');
    expect(
      buildingUseFor(feature({ building: 'cathedral', amenity: 'place_of_worship' })),
    ).toBe('religious');
    expect(buildingUseFor(feature({ building: 'yes', historic: 'church' }))).toBe('religious');
    expect(buildingUseFor(feature({ building: 'yes', religion: 'christian' }))).toBe('religious');
    expect(buildingUseFor(feature({ building: 'yes' }, { name: 'Касцёл Святога Яна' }))).toBe(
      'religious',
    );
  });

  it('detects monuments and steles', () => {
    expect(buildingUseFor(feature({ building: 'yes', historic: 'monument' }))).toBe('monument');
    expect(buildingUseFor(feature({ building: 'yes', historic: 'memorial' }))).toBe('monument');
    expect(buildingUseFor(feature({ building: 'yes', man_made: 'obelisk' }))).toBe('monument');
    expect(buildingUseFor(feature({ building: 'yes', man_made: 'tower' }))).toBe('monument');
    expect(buildingUseFor(feature({ building: 'tower' }))).toBe('monument');
    expect(buildingUseFor(feature({ building: 'yes', tourism: 'artwork' }))).toBe('monument');
    expect(
      buildingUseFor(feature({ building: 'yes' }, { name: 'Манумент Перамогі' })),
    ).toBe('monument');
  });

  it('keeps roof-only structures windowless', () => {
    expect(buildingUseFor(feature({ building: 'roof' }))).toBe('roof');
    expect(buildingUseFor(feature({ building: 'carport' }))).toBe('roof');
  });

  it('detects assembly halls (theatre, circus, concert hall)', () => {
    expect(buildingUseFor(feature({ building: 'yes', amenity: 'theatre' }))).toBe('assembly');
    expect(buildingUseFor(feature({ building: 'yes', amenity: 'arts_centre' }))).toBe('assembly');
    expect(
      buildingUseFor(feature({ building: 'yes' }, { name: 'Беларускі дзяржаўны цырк' })),
    ).toBe('assembly');
  });

  it('keeps palaces monumental and stadiums sport', () => {
    expect(buildingUseFor(feature({ building: 'public', amenity: 'arts_centre' }, { archetype: 'palace' }))).toBe(
      'monumental',
    );
    expect(buildingUseFor(feature({ building: 'stadium' }))).toBe('sport');
    expect(buildingUseFor(feature({}, { archetype: 'stadium' }))).toBe('sport');
  });

  it('separates institutional, office, industrial, utility and residential', () => {
    expect(buildingUseFor(feature({ building: 'school' }))).toBe('institutional');
    expect(buildingUseFor(feature({ building: 'yes', amenity: 'hospital' }))).toBe('institutional');
    expect(buildingUseFor(feature({ building: 'office' }))).toBe('office');
    expect(buildingUseFor(feature({ building: 'industrial' }))).toBe('industrial');
    expect(buildingUseFor(feature({ building: 'garage' }))).toBe('utility');
    expect(buildingUseFor(feature({ building: 'yes' }))).toBe('residential');
    expect(buildingUseFor(feature({}))).toBe('residential');
    expect(buildingUseFor(null)).toBe('residential');
  });
});

describe('hasStrongStyleEvidence', () => {
  it('accepts explicit floors, heights and building subtypes', () => {
    expect(hasStrongStyleEvidence(feature({ building: 'apartments' }))).toBe(true);
    expect(hasStrongStyleEvidence(feature({ building: 'yes' }, { levels: 5 }))).toBe(true);
    expect(hasStrongStyleEvidence(feature({ building: 'yes', 'building:levels': '5' }))).toBe(true);
    expect(hasStrongStyleEvidence(feature({ building: 'yes', height: '18' }))).toBe(true);
  });

  it('rejects anonymous building=yes footprints', () => {
    expect(hasStrongStyleEvidence(feature({ building: 'yes' }))).toBe(false);
    expect(hasStrongStyleEvidence(feature({}))).toBe(false);
    expect(hasStrongStyleEvidence(null)).toBe(false);
  });
});
