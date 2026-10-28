/**
 * Curated landmark registry (Lead-owned integration point).
 *
 * Landmarks in this list replace the generic per-volume extrusion entirely:
 * `buildBuildingsMesh` calls `addCuratedLandmark` before the volume loop and
 * skips the regular mesh when it returns true. Additive landmarks that only
 * decorate the regular mesh (e.g. the Minsk Gate crown) are NOT listed here —
 * they are dispatched from the volume loop instead.
 *
 * Each landmark module owns its geometry + tests; this file only routes.
 */

import type { BuildingFeature } from '../../shared/types';
import type { MeshSink } from './meshSink';
import { addNationalLibrary, isNationalLibraryBuilding } from './nationalLibrary';
import { addRedChurch, isRedChurchBuilding } from './redChurch';
import type { BuildingStyle } from './style';
import { addVictoryObelisk, isVictoryObeliskBuilding } from './victoryObelisk';

export interface CuratedLandmarkRoute {
  /** Stable landmark id from `LandmarkId` (src/shared/types.ts). */
  id: string;
  /** True when the building belongs to this curated landmark. */
  matches(building: BuildingFeature): boolean;
  /** Rebuild the landmark; never throws (reports through `onWarning`). */
  build(
    sink: MeshSink,
    building: BuildingFeature,
    style: BuildingStyle,
    onWarning: (message: string) => void,
  ): void;
}

/** Landmarks that replace the generic extrusion, in routing order. */
export const CURATED_LANDMARKS: readonly CuratedLandmarkRoute[] = [
  {
    id: 'national-library',
    matches: isNationalLibraryBuilding,
    build: (sink, building, style, warn) => addNationalLibrary(sink, building, style, warn),
  },
  {
    id: 'victory-obelisk',
    matches: isVictoryObeliskBuilding,
    build: (sink, building, style, warn) => addVictoryObelisk(sink, building, style, warn),
  },
  {
    id: 'red-church',
    matches: isRedChurchBuilding,
    build: (sink, building, style, warn) => addRedChurch(sink, building, style, warn),
  },
];

/**
 * True when the feature is a curated landmark that replaces the generic mesh.
 *
 * Used by the tile build to keep the "landmark" override visible in diagnostics.
 */
export function isCuratedLandmarkReplacement(building: BuildingFeature): boolean {
  return CURATED_LANDMARKS.some((route) => route.matches(building));
}

/**
 * Route one curated landmark to its builder.
 *
 * Returns true when the landmark was handled (the caller must skip the generic
 * volume loop). Never throws: build failures are reported through `onWarning`
 * and the landmark is still considered handled, so the tile never renders the
 * generic extrusion of a curated landmark by accident.
 */
export function addCuratedLandmark(
  sink: MeshSink,
  building: BuildingFeature,
  style: BuildingStyle,
  onWarning: (message: string) => void,
): boolean {
  const route = CURATED_LANDMARKS.find((candidate) => candidate.matches(building));
  if (!route) return false;
  try {
    route.build(sink, building, style, onWarning);
  } catch (error) {
    onWarning(
      `curated landmark "${route.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return true;
}
