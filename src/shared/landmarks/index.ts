/**
 * Low-poly landmark models: catalog + the OSM buildings they replace.
 *
 * `catalog.json` is written by `scripts/landmarks/fit_placements.py` (placement
 * of each GLB on the OSM footprints) and baked into `public/data/landmarks` by
 * `scripts/landmarks/bake_landmarks.py`. A model often stands for several OSM
 * objects (the Holy Spirit cathedral is the church, the Bernardine monastery
 * and a gatehouse), so every entry carries the full `hide` list: tile
 * payloads stay untouched and the mesh builder skips those ids instead.
 */

import { publicAssetUrl } from '../assets';
import catalog from './catalog.json';

export interface LandmarkCatalogEntry {
  slug: string;
  label: string;
  /** OSM object the model is named after (`w123` / `n123`). */
  osm: string;
  /** Present once the model has been fitted onto the map. */
  placement?: { x: number; y: number; yaw: number; scale: number; iou: number | null };
  /** OSM building ids that must not be extruded when the model is shown. */
  hide?: string[];
  status?: 'unplaced';
  note?: string;
}

const entries = (catalog as { landmarks: LandmarkCatalogEntry[] }).landmarks;

/** Landmarks that have a placement and therefore a baked model. */
export const PLACED_LANDMARKS: readonly LandmarkCatalogEntry[] = entries.filter(
  (entry) => entry.placement !== undefined && entry.status !== 'unplaced',
);

/** Building ids replaced by a landmark model (consumed by the mesh builder). */
export const LANDMARK_HIDDEN_BUILDING_IDS: ReadonlySet<string> = new Set(
  PLACED_LANDMARKS.flatMap((entry) => entry.hide ?? []),
);

export const LANDMARK_MODELS = {
  dataUrl: publicAssetUrl('data/landmarks'),
} as const;

/** `?focus=<slug>` value naming a placed landmark (QA deep link), or null. */
export function landmarkFocusSlug(search?: string): string | null {
  const raw = search ?? (typeof location !== 'undefined' ? location.search : '');
  const value = new URLSearchParams(raw).get('focus');
  return value && PLACED_LANDMARKS.some((entry) => entry.slug === value) ? value : null;
}
