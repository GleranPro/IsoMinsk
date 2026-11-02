/**
 * Shared flat colours for rail/tram geometry.
 *
 * The legacy buffered-polygon path (`roadMeshes.ts`) and the payload-0.2.0
 * centreline path (`networkMeshes.ts`) draw the same tram ballast and rail
 * heads, so both read the two colours from here instead of duplicating the
 * palette derivation (and so the legacy look is preserved exactly).
 *
 * Owned by the environment/roads module; the palette values themselves live in
 * `src/engine/materials/palette.ts`.
 */

import { shadeHex } from '../../engine/materials/palette';

/** Tram/rail ballast: a touch darker than the shared railway colour. */
export const RAIL_BALLAST_COLOR = shadeHex('#7b7367', -0.18);
/** Rail heads: lighter, steel-ish. */
export const RAIL_HEAD_COLOR = shadeHex('#7b7367', 0.55);
