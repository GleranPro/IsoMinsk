/**
 * Lipki aviation museum — shared placement constants.
 *
 * Used by the engine (camera focus, layer URL) and the React shell (the
 * "museum" control). Local metres: x east, y north, origin PILOT_CENTER
 * (see scripts/geo_config.py and src/shared/config.ts).
 */

export const MUSEUM = {
  /** Centre of the exhibition grounds (the layer adds itself here). */
  origin: { x: 9300, y: 650 },
  /** Camera target for the "fly to the museum" control. */
  focus: { x: 9300, y: 655 },
  /** Orthographic height that frames the rows and the hangar. */
  orthoHeight: 170,
  /** Static payload exported by scripts/qa/export_museum_web.py. */
  dataUrl: '/data/museum',
  /** Rows of open-air exhibits (used by labels/QA). */
  label: 'Авиамузей «Липки»',
} as const;

/** `?focus=lipki` deep link value. */
export function isMuseumFocus(search?: string): boolean {
  const raw = search ?? (typeof location !== 'undefined' ? location.search : '');
  return new URLSearchParams(raw).get('focus') === 'lipki';
}
