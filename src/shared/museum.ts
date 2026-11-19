/**
 * Lipki aviation museum — shared placement constants.
 *
 * Used by the engine (camera focus, layer URL) and the React shell (the
 * "museum" control). Local metres: x east, y north, origin PILOT_CENTER
 * (see scripts/geo_config.py and src/shared/config.ts).
 */

import { publicAssetUrl } from './assets';

export const MUSEUM = {
  /** Centre of the exhibition grounds (the layer adds itself here). */
  origin: { x: 9300, y: 650 },
  /** Camera target for the "fly to the museum" control. */
  focus: { x: 9300, y: 655 },
  /** Orthographic height that frames the rows and the hangar. */
  orthoHeight: 170,
  /**
   * Static payload exported by scripts/qa/export_museum_web.py. Resolved below
   * the deployment base like every other public asset (see `publicAssetUrl`).
   */
  dataUrl: publicAssetUrl('data/museum'),
  /** Rows of open-air exhibits (used by labels/QA). */
  label: 'Авиамузей «Липки»',
} as const;

/**
 * Li-2 c/n 33444309 displayed beside the Belarusian State Museum of the
 * History of the Great Patriotic War (OSM way 127103385 is the building).
 * The aircraft itself is mapped as OSM way 384806738; its round pad centre is
 * used as the exhibit origin. Exported by scripts/war-museum/export_web.py.
 */
export const WAR_MUSEUM = {
  /** Centre of the aircraft on its round pad (local metres). */
  origin: { x: -1584.04, y: 1646.18 },
  /** Camera target for the `?focus=li2` QA deep link. */
  focus: { x: -1584.04, y: 1646.18 },
  /** Orthographic height that frames the aircraft and the museum entrance. */
  orthoHeight: 70,
  dataUrl: publicAssetUrl('data/warmuseum'),
  label: 'Ли-2 у музея истории ВОВ',
} as const;

/** `?focus=lipki` deep link value. */
export function isMuseumFocus(search?: string): boolean {
  const raw = search ?? (typeof location !== 'undefined' ? location.search : '');
  return new URLSearchParams(raw).get('focus') === 'lipki';
}

/** `?focus=li2` deep link value (War Museum Li-2). */
export function isLi2Focus(search?: string): boolean {
  const raw = search ?? (typeof location !== 'undefined' ? location.search : '');
  return new URLSearchParams(raw).get('focus') === 'li2';
}
