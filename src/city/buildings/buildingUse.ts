/**
 * Building use derived from the payload tags.
 *
 * The offline pipeline only knows eleven broad archetypes, so a church, a circus
 * and a plain apartment block can all arrive as `civic`. The facade grammar needs
 * a finer split: a church gets arched openings, a monument gets blank stone and a
 * theatre gets sparse hall glazing. All the signals live in the tile payload
 * (`tags`), so the classification happens at render time and does not require a
 * data regeneration.
 */

import type { BuildingFeature } from '../../shared/types';

export type BuildingUse =
  | 'residential'
  | 'office'
  | 'institutional'
  | 'religious'
  | 'monument'
  | 'assembly'
  | 'industrial'
  | 'utility'
  | 'roof'
  | 'monumental'
  | 'sport';

const RELIGIOUS_BUILDINGS = new Set([
  'church',
  'cathedral',
  'chapel',
  'basilica',
  'shrine',
  'temple',
  'mosque',
  'synagogue',
]);

const MONUMENT_BUILDINGS = new Set(['monument', 'memorial', 'obelisk', 'stele']);

const ASSEMBLY_AMENITIES = new Set([
  'theatre',
  'arts_centre',
  'concert_hall',
  'cinema',
]);

const INSTITUTIONAL_BUILDINGS = new Set([
  'school',
  'university',
  'college',
  'kindergarten',
  'hospital',
  'clinic',
  'museum',
  'library',
  'government',
  'public',
  'civic',
  'train_station',
  'transportation',
  'dormitory',
  'hotel',
]);

const INSTITUTIONAL_AMENITIES = new Set([
  'school',
  'university',
  'college',
  'kindergarten',
  'hospital',
  'clinic',
  'museum',
  'library',
  'townhall',
  'courthouse',
  'police',
  'fire_station',
  'government',
  'public_building',
  'community_centre',
  'events_venue',
  'conference_centre',
  'train_station',
  'bus_station',
]);

const INDUSTRIAL_BUILDINGS = new Set([
  'industrial',
  'factory',
  'warehouse',
  'hangar',
  'manufacture',
  'storage_tank',
  'barn',
  'depot',
  'works',
]);

const SMALL_BUILDINGS = new Set([
  'garage',
  'garages',
  'shed',
  'hut',
  'kiosk',
  'carport',
  'toilets',
  'transformer_tower',
  'service',
  'roof',
]);

const ASSEMBLY_NAME = /(цырк|цирк|circus|тэатр|театр|theatre|філармон|филармон|concert)/i;
const RELIGIOUS_NAME = /(касцёл|костёл|царква|церковь|сабор|собор|храм|church|cathedral)/i;
const MONUMENT_NAME = /(манумент|монумент|помнік|памятник|obelisk|стела|stela)/i;

function tag(tags: Record<string, string> | undefined, key: string): string {
  const value = tags?.[key];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function nameOf(building: BuildingFeature): string {
  const tags = building.tags;
  return (
    building.name ||
    tags?.['name:ru'] ||
    tags?.['name:be'] ||
    tags?.['name:en'] ||
    tags?.name ||
    ''
  );
}

/**
 * Classify one feature by its tags, with the archetype as the final fallback.
 *
 * Order matters: a palace that is also tagged `amenity=arts_centre` stays
 * `monumental`, and a cathedral that is a tourist attraction stays `religious`.
 */
export function buildingUseFor(building: BuildingFeature | null | undefined): BuildingUse {
  if (!building) return 'residential';
  const tags = building.tags;
  const archetype = building.archetype;
  const buildingTag = tag(tags, 'building');
  const amenity = tag(tags, 'amenity');
  const historic = tag(tags, 'historic');
  const manMade = tag(tags, 'man_made');
  const tourism = tag(tags, 'tourism');
  const religion = tag(tags, 'religion');
  const name = nameOf(building);

  if (archetype === 'palace' || buildingTag === 'palace') return 'monumental';
  if (
    archetype === 'stadium' ||
    buildingTag === 'stadium' ||
    buildingTag === 'grandstand' ||
    buildingTag === 'sports_hall' ||
    tag(tags, 'leisure') === 'stadium'
  ) {
    return 'sport';
  }

  if (
    RELIGIOUS_BUILDINGS.has(buildingTag) ||
    amenity === 'place_of_worship' ||
    historic === 'church' ||
    historic === 'cathedral' ||
    historic === 'chapel' ||
    (religion !== '' && (buildingTag === '' || buildingTag === 'yes')) ||
    RELIGIOUS_NAME.test(name)
  ) {
    return 'religious';
  }
  if (
    MONUMENT_BUILDINGS.has(buildingTag) ||
    MONUMENT_BUILDINGS.has(historic) ||
    historic === 'monument' ||
    historic === 'memorial' ||
    manMade === 'obelisk' ||
    manMade === 'monument' ||
    manMade === 'tower' ||
    manMade === 'water_tower' ||
    manMade === 'chimney' ||
    buildingTag === 'tower' ||
    tourism === 'artwork' ||
    MONUMENT_NAME.test(name)
  ) {
    return 'monument';
  }
  // Roof-only structures (canopies, the circus dome relation) are mapped as
  // volumes but must not paint windows: their walls are often a solid drum that
  // overlaps the building they cover.
  if (buildingTag === 'roof' || buildingTag === 'carport' || manMade === 'roof') {
    return 'roof';
  }
  if (
    ASSEMBLY_AMENITIES.has(amenity) ||
    ASSEMBLY_NAME.test(name) ||
    buildingTag === 'theatre' ||
    buildingTag === 'cinema'
  ) {
    return 'assembly';
  }

  if (
    INSTITUTIONAL_BUILDINGS.has(buildingTag) ||
    INSTITUTIONAL_AMENITIES.has(amenity) ||
    INSTITUTIONAL_BUILDINGS.has(amenity)
  ) {
    return 'institutional';
  }
  if (
    archetype === 'office' ||
    buildingTag === 'office' ||
    buildingTag === 'commercial' ||
    buildingTag === 'retail' ||
    buildingTag === 'supermarket' ||
    buildingTag === 'mall' ||
    tag(tags, 'office') !== '' ||
    tag(tags, 'shop') === 'mall' ||
    tag(tags, 'shop') === 'department_store'
  ) {
    return 'office';
  }
  if (archetype === 'industrial' || INDUSTRIAL_BUILDINGS.has(buildingTag)) return 'industrial';
  if (archetype === 'small' || SMALL_BUILDINGS.has(buildingTag)) return 'utility';
  if (archetype === 'civic') return 'institutional';
  return 'residential';
}

/**
 * True when the payload carries an explicit height, floor count or building
 * subtype. Anonymous `building=yes` footprints are the ones that used to get
 * invented massing profiles and pilasters; they should stay plain.
 */
export function hasStrongStyleEvidence(building: BuildingFeature | null | undefined): boolean {
  if (!building) return false;
  const tags = building.tags;
  const subtype = tag(tags, 'building');
  if (subtype !== '' && subtype !== 'yes') return true;
  if (Number.isFinite(building.levels) && (building.levels ?? 0) > 0) return true;
  if (tag(tags, 'building:levels') !== '' || tag(tags, 'levels') !== '') return true;
  if (
    tag(tags, 'height') !== '' ||
    tag(tags, 'building:height') !== '' ||
    tag(tags, 'est_height') !== ''
  ) {
    return true;
  }
  return false;
}

/** Name-only fallbacks used by tests and the info panel. */
export const BUILDING_USE_NAME_PATTERNS = {
  assembly: ASSEMBLY_NAME,
  religious: RELIGIOUS_NAME,
  monument: MONUMENT_NAME,
} as const;
