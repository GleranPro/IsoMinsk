/**
 * Isometric Minsk — shared geometry contract between the building mesh builder,
 * the facade shader, and the renderer.
 *
 * Every building vertex carries the attributes listed below. The facade
 * material (owned by the facades/art-direction module) consumes them in GLSL;
 * the mesh builder (owned by the buildings module) produces them. Do not change
 * the layout without updating both sides and `src/shared/geometry.ts` consumers.
 *
 * Vertex attributes for building meshes:
 *   position  vec3  local metres: x east, y up, z = -north
 *   normal    vec3  unit face normal
 *   aUV       vec2  wall faces: u = horizontal distance along the facade in
 *                   metres (already accumulated along the face polyline),
 *                   v = height above the building base in metres.
 *                   Roof faces: u,v = planar local coords in metres.
 *   aColor    vec3  sRGB base colour (linearised in the shader)
 *   aStyle    vec4  x = archetype id, y = floor height (m),
 *                   z = ground floor height (m), w = per-building seed [0,1]
 *   aFace     vec4  x = face kind (see FACE_KIND),
 *                   y = packed style integer: bits 0..7 = STYLE_FLAG bitmask,
 *                       bits 8..15 = style recipe id (0..255; schema 1 uses
 *                       0..26 for the family catalog and 27..37 for the legacy
 *                       archetype presets),
 *                   z = trim/cornice intensity [0..1], w = detail scale hint
 *
 * The packed integer stays exactly representable in float32 (<= 16 bits), so the
 * shader can mask the flag byte and read the recipe index without precision
 * loss. Roof faces keep aFace.w = ROOF_SHAPE_ID.
 */

import type { Archetype, RoofShape } from './types';

/** Bit position of the recipe id inside the packed `aFace.y` integer. */
export const STYLE_RECIPE_SHIFT = 8;
/** Mask of the style flag byte inside the packed `aFace.y` integer. */
export const STYLE_FLAG_MASK = 0xff;
/** Largest recipe id schema 1 may transmit (bits 8..15). */
export const STYLE_RECIPE_MAX = 255;

/** Face kinds understood by the facade shader. */
export const FACE_KIND = {
  wall: 0,
  roof: 1,
  ground: 2, // plinth / ground floor band
  trim: 3, // cornices, parapets, ledges
  glass: 4, // shopfront / continuous glazing
  roofRidge: 5, // sloped roof surfaces (shingle-ish treatment)
} as const;

export type FaceKind = (typeof FACE_KIND)[keyof typeof FACE_KIND];

/** Style flags packed into aFace.y. */
export const STYLE_FLAG = {
  /** Vertical window rhythm has wider spacing (Stalinist). */
  monument: 1 << 0,
  /** Balcony bands on every other floor (panel blocks). */
  balconies: 1 << 1,
  /** Continuous shopfront glazing on the ground floor. */
  shopfront: 1 << 2,
  /** Cornice band at the top of the facade. */
  cornice: 1 << 3,
  /** Rusticated / pilaster vertical rhythm. */
  pilasters: 1 << 4,
  /** Ribbon windows (offices / modern). */
  ribbon: 1 << 5,
  /** No windows at all (industrial sheds, garages). */
  blank: 1 << 6,
  /** Mansard-ish attic band above the cornice. */
  attic: 1 << 7,
} as const;

export type StyleFlagName = keyof typeof STYLE_FLAG;

/** Integer ids for archetypes, used as aStyle.x. */
export const ARCHETYPE_ID: Record<Archetype, number> = {
  stalin: 0,
  khrushchev: 1,
  panel: 2,
  modern: 3,
  office: 4,
  historic: 5,
  industrial: 6,
  small: 7,
  civic: 8,
  palace: 9,
  stadium: 10,
};

export const ARCHETYPE_BY_ID: Archetype[] = [
  'stalin',
  'khrushchev',
  'panel',
  'modern',
  'office',
  'historic',
  'industrial',
  'small',
  'civic',
  'palace',
  'stadium',
];

/** Integer ids for roof shapes, used as aFace.w on roof faces. */
export const ROOF_SHAPE_ID: Record<RoofShape, number> = {
  flat: 0,
  gabled: 1,
  hipped: 2,
  pyramidal: 3,
  skillion: 4,
  dome: 5,
  complex: 6,
};

/** Byte size of one building vertex (interleaved layout is not used; see docs). */
export const BUILDING_ATTRIBUTE_NAMES = [
  'position',
  'normal',
  'aUV',
  'aColor',
  'aStyle',
  'aFace',
] as const;
