/**
 * Isometric Minsk — architectural facade presets.
 *
 * One preset per archetype drives both the facade shader (window metrics,
 * decoration) and the geometry builder (which style flags it writes into the
 * vertex attributes). Owned by the facades / art-direction module.
 *
 * All dimensions are metres unless stated otherwise; ratios are 0..1 of the
 * storey height or of the window bay width.
 *
 * Art-direction notes (target: 320-420 px tall internal render):
 *  - Bay widths stay inside 2.8-4.2 m so that at 3-5 px/m (street-level zoom) a
 *    window is 6-14 px wide and the punched-window rhythm stays legible.
 *  - At overview zoom (≈0.5 px/m, a 3 m bay is ~1.5 px) the shader switches to
 *    an averaged tone per bay/floor, so presets are tuned for both scales:
 *    window ratios are high enough (~0.44-0.72 of the bay) that the average
 *    reads as "glazed" rather than "blank concrete".
 *  - Stalinist ensembles: bigger bays, taller floors, stronger cornice, warm
 *    plaster. Khrushchev: small windows, sparse ornament. Panel: wide bays,
 *    monotonous balconies, cool concrete. Modern/office: ribbon glazing.
 *  - Historic: narrow bays, tall thin windows, pitched roofs, mansard attic.
 */

import type { Archetype } from '../../shared/types';
import { ARCHETYPE_ID, STYLE_FLAG } from '../../shared/geometry';
import { ARCHETYPE_COLORS, ROOF_COLORS, trimColorFor } from '../../engine/materials/palette';

export interface FacadePreset {
  archetype: Archetype;
  /** Integer id written into aStyle.x. */
  id: number;
  /** Default storey height when the data does not specify one. */
  floorHeight: number;
  /** Ground floor height (shops / taller lobbies). */
  groundFloorHeight: number;
  /** Window bay width: distance between window centres. */
  bayWidth: number;
  /** Window width as a fraction of bayWidth. */
  windowWidthRatio: number;
  /** Window height as a fraction of the storey height. */
  windowHeightRatio: number;
  /** Sill height above the floor slab, as a fraction of floorHeight. */
  sillRatio: number;
  /** Style flags bitmask (see STYLE_FLAG). */
  flags: number;
  /** Cornice band height, metres (0 = none). */
  corniceHeight: number;
  /** Fraction of floors that carry balcony bands (0 = none). */
  balconyRatio: number;
  /** Roof colour family used by the geometry builder. */
  roofColorFamily: 'flat' | 'sloped' | 'metal';
  /** Facade colours to pick from. */
  colors: readonly string[];
}

const F = STYLE_FLAG;

export const FACADE_PRESETS: Record<Archetype, FacadePreset> = {
  // Soviet neoclassical / Stalinist ensembles along Independence Avenue:
  // monumental bays, pilasters, strong cornice, tall ground floor with shops.
  stalin: {
    archetype: 'stalin',
    id: ARCHETYPE_ID.stalin,
    floorHeight: 3.7,
    groundFloorHeight: 4.8,
    bayWidth: 3.7,
    windowWidthRatio: 0.46,
    windowHeightRatio: 0.64,
    sillRatio: 0.16,
    flags: F.monument | F.pilasters | F.cornice | F.shopfront,
    corniceHeight: 1.15,
    balconyRatio: 0,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.stalin,
  },
  // Khrushchev-era 5-storey blocks: small punched windows, sparse decoration,
  // freestanding balconies on some bays.
  khrushchev: {
    archetype: 'khrushchev',
    id: ARCHETYPE_ID.khrushchev,
    floorHeight: 2.8,
    groundFloorHeight: 2.9,
    bayWidth: 3.2,
    windowWidthRatio: 0.44,
    windowHeightRatio: 0.52,
    sillRatio: 0.22,
    flags: F.balconies | F.cornice,
    corniceHeight: 0.35,
    balconyRatio: 0.55,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.khrushchev,
  },
  // Brezhnev-era 9-12 storey panel blocks: wide bays, continuous balcony bands,
  // deliberately repetitive and cooler than the plaster ensembles.
  panel: {
    archetype: 'panel',
    id: ARCHETYPE_ID.panel,
    floorHeight: 2.8,
    groundFloorHeight: 3.0,
    bayWidth: 3.4,
    windowWidthRatio: 0.58,
    windowHeightRatio: 0.50,
    sillRatio: 0.24,
    flags: F.balconies | F.cornice,
    corniceHeight: 0.30,
    balconyRatio: 0.8,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.panel,
  },
  // Modern apartment towers: glazed bands, vertical accents, tall lobby.
  modern: {
    archetype: 'modern',
    id: ARCHETYPE_ID.modern,
    floorHeight: 3.2,
    groundFloorHeight: 4.4,
    bayWidth: 4.0,
    windowWidthRatio: 0.70,
    windowHeightRatio: 0.62,
    sillRatio: 0.14,
    flags: F.ribbon | F.shopfront | F.cornice,
    corniceHeight: 0.25,
    balconyRatio: 0.15,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.modern,
  },
  // Standard offices and commercial: ribbon windows, shopfronts, heavy base.
  office: {
    archetype: 'office',
    id: ARCHETYPE_ID.office,
    floorHeight: 3.6,
    groundFloorHeight: 4.6,
    bayWidth: 4.2,
    windowWidthRatio: 0.72,
    windowHeightRatio: 0.52,
    sillRatio: 0.20,
    flags: F.ribbon | F.shopfront | F.cornice,
    corniceHeight: 0.30,
    balconyRatio: 0,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.office,
  },
  // Pre-war low-rise: small punched windows, plastered walls, pitched roofs,
  // a mansard-ish attic band above the cornice.
  historic: {
    archetype: 'historic',
    id: ARCHETYPE_ID.historic,
    floorHeight: 3.4,
    groundFloorHeight: 3.5,
    bayWidth: 3.0,
    windowWidthRatio: 0.38,
    windowHeightRatio: 0.56,
    sillRatio: 0.24,
    flags: F.cornice | F.attic,
    corniceHeight: 0.60,
    balconyRatio: 0.10,
    roofColorFamily: 'sloped',
    colors: ARCHETYPE_COLORS.historic,
  },
  // Industrial sheds / depots: very wide structural bays, high clerestory
  // ribbon glazing, metal roofs. The 'blank' style is supported by the shader
  // but the pilot area's sheds get high glazing instead of blank walls.
  industrial: {
    archetype: 'industrial',
    id: ARCHETYPE_ID.industrial,
    floorHeight: 6.0,
    groundFloorHeight: 6.0,
    bayWidth: 7.5,
    windowWidthRatio: 0.62,
    windowHeightRatio: 0.32,
    sillRatio: 0.52,
    flags: F.ribbon,
    corniceHeight: 0,
    balconyRatio: 0,
    roofColorFamily: 'metal',
    colors: ARCHETYPE_COLORS.industrial,
  },
  // Garages, kiosks, outbuildings: tiny punched windows, low sawn roofs.
  small: {
    archetype: 'small',
    id: ARCHETYPE_ID.small,
    floorHeight: 2.8,
    groundFloorHeight: 2.8,
    bayWidth: 3.2,
    windowWidthRatio: 0.32,
    windowHeightRatio: 0.46,
    sillRatio: 0.28,
    flags: 0,
    corniceHeight: 0.18,
    balconyRatio: 0,
    roofColorFamily: 'sloped',
    colors: ARCHETYPE_COLORS.small,
  },
  // Public / cultural / religious buildings: tall bays, strong cornice, stone.
  civic: {
    archetype: 'civic',
    id: ARCHETYPE_ID.civic,
    floorHeight: 4.4,
    groundFloorHeight: 5.2,
    bayWidth: 3.6,
    windowWidthRatio: 0.40,
    windowHeightRatio: 0.68,
    sillRatio: 0.15,
    flags: F.monument | F.pilasters | F.cornice,
    corniceHeight: 1.0,
    balconyRatio: 0,
    roofColorFamily: 'flat',
    colors: ARCHETYPE_COLORS.civic,
  },
};

export function presetFor(archetype: Archetype): FacadePreset {
  return FACADE_PRESETS[archetype] ?? FACADE_PRESETS.small;
}

/** Style flag bitmask for the shader. */
export function styleFlagsFor(archetype: Archetype): number {
  return presetFor(archetype).flags;
}

/** Trim / cornice colour for an archetype base colour. */
export function trimColor(archetype: Archetype, baseColor: string): string {
  return trimColorFor(baseColor);
}

/** Roof colour family for an archetype. */
export function roofFamilyFor(archetype: Archetype): 'flat' | 'sloped' | 'metal' {
  return presetFor(archetype).roofColorFamily;
}

/** Pick a roof colour honouring the archetype family (deterministic by seed). */
export function roofColorFor(archetype: Archetype, seed: number): string {
  const family = roofFamilyFor(archetype);
  const colors =
    family === 'flat' ? ROOF_COLORS.flat : family === 'metal' ? ROOF_COLORS.metal : ROOF_COLORS.sloped;
  const index = Math.floor(fract(Math.abs(Math.sin((seed + 0.13) * 91.13)) * 1000) * colors.length) % colors.length;
  return colors[index];
}

/**
 * Palette used by the pixel-art colour quantisation pass. Canonical definition
 * lives in src/engine/postprocess/palette.ts (shared with the facade material
 * and imported by the renderer's post-processing pass); re-exported here for
 * historical imports.
 */
export { PIXEL_PALETTE, PIXEL_PALETTE_SIZE } from '../../engine/postprocess/palette';

function fract(value: number): number {
  return value - Math.floor(value);
}
