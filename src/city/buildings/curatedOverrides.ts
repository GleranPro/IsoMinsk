/**
 * Curated per-building corrections for OSM mapping defects.
 *
 * The generic heuristics cannot know that a sprawling `building=yes` footprint
 * with no height/levels tags is a one-storey pavilion rather than a six-storey
 * Stalinist block. This table is intentionally tiny and auditable: every entry
 * documents one verified defect, and it is applied at mesh-build time so the
 * release payload does not have to be regenerated.
 */

import type { Archetype, BuildingFeature, BuildingVolume, Polygon } from '../../shared/types';
import { pointInPolygon, polygonCentroid, type Point2 } from './polygon2d';
import w175398077Mass from './data/w175398077-mass.json';

export interface BuildingOverride {
  /** Corrected total height in metres. */
  height?: number;
  /** Corrected above-ground floor count (info panel). */
  levels?: number;
  /** Corrected broad archetype (facade family fallback). */
  archetype?: Archetype;
  /**
   * The mapper tagged upper stages with `building:min_level` but the stages
   * below them were cut away by the part de-overlap, so the parts hang in the
   * air. Stretch every unsupported elevated part down to the ground.
   */
  groundElevatedParts?: boolean;
  /**
   * Replacement for the building's non-part volumes: the main mass that the
   * part de-overlap left at a wrong height. Parts are kept.
   */
  mass?: readonly { footprint: Polygon; height: number }[];
}

export const BUILDING_OVERRIDES: Readonly<Record<string, BuildingOverride>> = {
  // Кастрычніцкая 5А: OSM has only `building=yes` and no height/levels, so the
  // untagged-footprint heuristic produced a 22 m / 6-storey Stalinist block.
  // The real building is a low 1-2 storey pavilion. Only the height is corrected:
  // the feature keeps its data archetype/recipe, and the weak-evidence facade
  // policy strips the invented monumental trim.
  w25326783: { height: 8 },
  // ЖК «У Троицкого» (Старожевская 6): 22 building:parts, 16 of them start at
  // `building:min_level` 2..25 (towers rising from 7 to 29 storeys). The stages
  // below them are not mapped as parts and the normaliser cuts the outline
  // around every part, so the upper stages floated 6..75 m above a 6 m podium
  // as thin slabs. They are the upper floors of towers that start on the ground.
  //
  // The remainder of the outline (the actual main mass, 3200 m2) was extruded to
  // only 6 m, so just the stages were drawn. It is rebuilt as a stepped mass from
  // the stages themselves (scripts/qa/curated_mass_w175398077.py): 22 m at the
  // low end rising to 69 m, the stages sit on it.
  w175398077: { groundElevatedParts: true, mass: w175398077Mass.volumes as unknown as BuildingOverride['mass'] },
};

/** Vertical slack when deciding whether a lower volume carries an elevated part. */
const SUPPORT_TOL_M = 0.5;

function volumeContains(volume: BuildingVolume, point: Point2): boolean {
  return pointInPolygon(volume.footprint as readonly (readonly Point2[])[], point[0], point[1]);
}

/**
 * Lower every elevated `building:part` that has nothing underneath it to the
 * building's base level. A part counts as supported when another volume covers
 * its footprint centre and reaches up to the part's bottom.
 */
export function groundElevatedParts(volumes: readonly BuildingVolume[]): BuildingVolume[] {
  const baseLevel = volumes.reduce(
    (low, volume) => (volume.isPart ? low : Math.min(low, volume.minHeight)),
    Number.POSITIVE_INFINITY,
  );
  const ground = Number.isFinite(baseLevel) ? Math.max(0, baseLevel) : 0;
  return volumes.map((volume, index) => {
    if (!volume.isPart || volume.minHeight <= ground + SUPPORT_TOL_M) return volume;
    const centre = polygonCentroid(volume.footprint as readonly (readonly Point2[])[]);
    const supported = volumes.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.minHeight <= volume.minHeight + SUPPORT_TOL_M &&
        other.height >= volume.minHeight - SUPPORT_TOL_M &&
        volumeContains(other, centre),
    );
    return supported ? volume : { ...volume, minHeight: ground };
  });
}

/**
 * Scale every volume's height (and roof rise) so the building top matches the
 * corrected total height. `minHeight` is preserved: an elevated building:part
 * must not slide down the facade.
 */
export function scaleVolumesToHeight(
  volumes: readonly BuildingVolume[],
  sourceHeight: number,
  targetHeight: number,
): BuildingVolume[] {
  if (!(sourceHeight > 0) || !(targetHeight > 0)) return [...volumes];
  const ratio = targetHeight / sourceHeight;
  return volumes.map((volume) => {
    const base = volume.minHeight;
    const span = volume.height - base;
    if (!(span > 0)) return volume;
    const scaledSpan = Math.max(0.5, span * ratio);
    const top = Math.min(base + scaledSpan, Math.max(base + 0.5, targetHeight));
    return {
      ...volume,
      height: top,
      roofHeight: Math.max(0, volume.roofHeight * ratio),
    };
  });
}

/** Apply a curated correction (if any) without mutating the input feature. */
export function applyBuildingOverride(building: BuildingFeature): BuildingFeature {
  const override = BUILDING_OVERRIDES[building.id];
  if (!override || building.landmark) return building;
  const targetHeight = override.height;
  let volumes =
    targetHeight !== undefined
      ? scaleVolumesToHeight(building.volumes, building.height, targetHeight)
      : building.volumes;
  if (override.mass) {
    const mass: BuildingVolume[] = override.mass.map((entry) => ({
      footprint: entry.footprint,
      minHeight: 0,
      height: entry.height,
      roofShape: 'flat',
      roofHeight: 0,
      heightSource: 'osm_levels',
    }));
    volumes = [...mass, ...volumes.filter((volume) => volume.isPart)];
  }
  if (override.groundElevatedParts) volumes = groundElevatedParts(volumes);
  return {
    ...building,
    archetype: override.archetype ?? building.archetype,
    height: targetHeight ?? building.height,
    levels: override.levels ?? building.levels,
    volumes,
  };
}
