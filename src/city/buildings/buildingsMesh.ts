/**
 * Isometric Minsk — procedural building mesh builder (Milestone B).
 *
 * Converts real OSM building footprints (`BuildingFeature[]`, already
 * de-overlapped into volumes by the offline pipeline) into ONE merged, indexed
 * THREE.BufferGeometry per tile:
 *   - extruded walls with ground-floor / shopfront bands,
 *   - roofs for every `RoofShape` (flat, gabled, hipped, pyramidal, skillion,
 *     dome, complex fallback) using a robust affine height-function envelope,
 *   - per-vertex facade attributes exactly per src/shared/geometry.ts.
 *
 * Vertex attribute contract (see src/shared/geometry.ts):
 *   position  vec3  world space: (localX, heightMetres, -localY)
 *   normal    vec3  explicit flat face normals (never smoothed / computed)
 *   aUV       vec2  walls: u = accumulated metres along the facade, v = height
 *                   above the volume base; roofs: local metres (x, y)
 *   aColor    vec3  **sRGB** 0..1 base colour (the facade shader linearises it)
 *   aStyle    vec4  (archetype id, floor height m, ground floor height m, seed)
 *                   aStyle.z = -1 marks an elevated building:part volume with
 *                   no ground-floor treatment (sentinel agreed with facades).
 *   aFace     vec4  (FACE_KIND, style flags, trim intensity 0..1, aFace.w)
 *                   aFace.w = ROOF_SHAPE_ID on FACE_KIND.roof / roofRidge faces,
 *                   otherwise the caller's detail scale hint (facades aligned).
 *
 * Deterministic: colours / window rhythms derive from `seedFromId(building.id)`.
 *
 * Triangles are flat-shaded: every triangle carries one explicit per-vertex
 * normal. Wall quads are emitted as indexed quads (4 shared vertices, two
 * triangles from the same corner) with the same flat normal on all vertices;
 * roof facets use the analytic facet normal. computeVertexNormals() is never
 * called.
 */

import type { BufferGeometry } from 'three';
import { FACE_KIND } from '../../shared/geometry';
import type { BuildingFeature, BuildingVolume, FeatureId } from '../../shared/types';
import { addRoof } from '../roofs/roofMesh';
import { addCityGateCrown, isCityGateBuilding } from './cityGate';
import { addCuratedLandmark } from './landmarks';
import { MeshSink } from './meshSink';
import { addPalaceAccents } from './palaceAccents';
import { profileVolumes } from './buildingProfiles';
import {
  addBalconyStack,
  addEntranceTreatment,
  addFacadeFrame,
  addRoofService,
  expandBounds,
  ringsBounds,
  type FacadeDetailContext,
} from './facadeDetails';
import {
  addStadiumBowl,
  grandstandVolume,
  isGrandstandBuilding,
  isStadiumBuilding,
  planStadiumBowl,
} from './stadium';
import {
  hasDetailModule,
  sanitiseDetailScale,
  styleForBuilding,
  withNoGroundBand,
  type BuildingStyle,
  type Vec4,
} from './style';
import { addVolumeWalls, boundaryRings, STREET_LEVEL_EPS, type RingInfo } from './walls';

export interface BuildingMeshOptions {
  /** Emit facade attributes (aUV/aStyle/aFace) — always written, but decorative
   * geometry (parapets, ground floor split, detail modules) is only emitted when true. */
  facadeDetail: boolean;
  /** Multiplier for the window "detail scale" attribute (LOD). */
  detailScale?: number;
  /**
   * Representation being built. `near` may apply bounded style profiles and
   * facade detail modules; `far` keeps the source massing and only the
   * mandatory walls/roofs (the same source ids are exported separately).
   */
  detailLevel?: 'near' | 'far';
}

/** Mandatory source massing vs optional decorative geometry of one tile. */
export interface BuildingMeshStats {
  buildings: number;
  /** Buildings whose rendered massing differs from the source volumes. */
  profiledBuildings: number;
  /** Triangles of mandatory source walls + roofs. */
  sourceTriangles: number;
  /** Triangles added by optional detail modules (facade frames, balconies, ...). */
  detailTriangles: number;
  totalTriangles: number;
  /** Count of detail modules that emitted at least one solid. */
  modulesEmitted: number;
  /** Detail modules that threw and were dropped (feature/module warnings). */
  moduleFailures: number;
  /** Byte size of the merged geometry attributes. */
  geometryBytes: number;
}

export interface BuildingMeshResult {
  geometry: BufferGeometry;
  /** One entry per triangle: index into `buildingIds`. */
  triangleOwner: Uint32Array;
  /** Stable ids parallel to triangleOwner values. */
  buildingIds: FeatureId[];
  triangleCount: number;
  /** Source vs decorative triangle/byte accounting (QA/performance gate). */
  stats: BuildingMeshStats;
  /** Non-fatal problems: skipped degenerate volumes, roof fallbacks, ... */
  warnings?: string[];
}

/** Volumes thinner than this are skipped (metres). */
const MIN_VOLUME_HEIGHT_M = 0.5;
/** Volumes smaller than this footprint area are skipped (m²). */
const MIN_VOLUME_AREA_M2 = 1;

/** Polygon area (exterior minus holes) computed from the cleaned rings. */
function polygonAreaFromRings(rings: readonly RingInfo[]): number {
  if (!rings.length) return 0;
  let area = Math.abs(rings[0].area);
  for (let i = 1; i < rings.length; i++) area -= Math.abs(rings[i].area);
  return area;
}

export function buildBuildingsMesh(
  buildings: BuildingFeature[],
  options: BuildingMeshOptions,
): BuildingMeshResult {
  const sink = new MeshSink();
  const warnings: string[] = [];
  const buildingIds: FeatureId[] = [];
  const detail = Boolean(options?.facadeDetail);
  const detailScale = sanitiseDetailScale(options?.detailScale);
  const detailLevel: 'near' | 'far' = options?.detailLevel === 'far' ? 'far' : 'near';
  const input: readonly BuildingFeature[] = Array.isArray(buildings) ? buildings : [];
  let profiledBuildings = 0;
  let sourceTriangles = 0;
  let detailTriangles = 0;
  let modulesEmitted = 0;
  let moduleFailures = 0;

  for (let buildingIndex = 0; buildingIndex < input.length; buildingIndex++) {
    const building = input[buildingIndex];
    const id = building && typeof building.id === 'string' ? building.id : `#${buildingIndex}`;
    buildingIds.push(id);

    if (!building) {
      warnings.push(`${id}: missing building feature`);
      continue;
    }

    let style: BuildingStyle;
    try {
      style = styleForBuilding(building, buildingIndex, detail, detailScale);
    } catch (error) {
      warnings.push(`${id}: could not resolve style (${describe(error)})`);
      continue;
    }

    const volumes: readonly BuildingVolume[] = Array.isArray(building.volumes)
      ? building.volumes
      : [];
    if (!volumes.length) {
      warnings.push(`${id}: building has no volumes`);
      continue;
    }

    // Curated landmarks (diamond library, obelisk, church) replace the whole
    // generic extrusion: their massing cannot be described by lofted volumes.
    if (
      addCuratedLandmark(sink, building, style, (message) => warnings.push(`${id}: ${message}`))
    ) {
      continue;
    }

    // Arena bowl special case: never extrude a stadium footprint as a slab.
    if (isStadiumBuilding(building)) {
      const plan = planStadiumBowl(building);
      if (plan) {
        try {
          addStadiumBowl(sink, plan, style);
        } catch (error) {
          warnings.push(`${id}: stadium bowl failed (${describe(error)})`);
        }
        continue;
      }
      warnings.push(`${id}: stadium bowl plan unavailable; rendered as extruded volumes`);
    }
    const grandstand = isGrandstandBuilding(building);
    const palace = building.archetype === 'palace' || building.tags?.building === 'palace';
    const protectedRoute = palace || grandstand || building.landmark !== undefined;

    // Bounded source-preserving massing profile (near representation only).
    const profiled = profileVolumes(volumes, {
      recipe: style.recipe,
      detailLevel,
      seed: style.seed,
      hasExplicitParts: volumes.some((volume) => volume.isPart === true),
      sourceHeight: building.height,
    });
    if (profiled.changed) profiledBuildings++;
    const renderedVolumes = profiled.volumes;

    // Allowed plan area for approved projections: the source footprint AABB
    // expanded by 0.45 m (design §8). Details never leave it.
    const buildingBounds = (() => {
      const boxes = renderedVolumes
        .map((volume) => ringsBounds(boundaryRings(volume)))
        .filter((box): box is [number, number, number, number] => box !== undefined);
      if (!boxes.length) return undefined;
      const merged: [number, number, number, number] = [
        Math.min(...boxes.map((box) => box[0])),
        Math.min(...boxes.map((box) => box[1])),
        Math.max(...boxes.map((box) => box[2])),
        Math.max(...boxes.map((box) => box[3])),
      ];
      return expandBounds(merged);
    })();

    // aUV.u is continuous across the volumes of one building so window bays
    // line up where a building:part meets the base volume.
    let uCursor = 0;

    for (let volumeIndex = 0; volumeIndex < renderedVolumes.length; volumeIndex++) {
      const volume = renderedVolumes[volumeIndex];
      const label = `${id} volume ${volumeIndex}`;
      try {
        const rings = boundaryRings(volume);
        if (!rings.length) {
          warnings.push(`${label}: skipped, degenerate footprint (no usable exterior ring)`);
          continue;
        }
        const height = volume.height - volume.minHeight;
        if (!(height >= MIN_VOLUME_HEIGHT_M)) {
          warnings.push(`${label}: skipped, degenerate height ${format(height)} m`);
          continue;
        }
        const area = polygonAreaFromRings(rings);
        if (!(area >= MIN_VOLUME_AREA_M2) || !Number.isFinite(area)) {
          warnings.push(`${label}: skipped, area ${format(area)} m²`);
          continue;
        }

        // Elevated parts must not get a ground-floor plinth at 10 m up.
        const baseStyle =
          volume.minHeight > STREET_LEVEL_EPS ? withNoGroundBand(style) : style;

        // Grandstands: low blank-walled stands with a sloped (skillion) top.
        const meshed = grandstand
          ? grandstandVolume(volume, baseStyle)
          : { volume, style: baseStyle };
        // Decorative trim must stay inside the declared envelope: a flat-roof
        // parapet occupies the top slice of the source height (the wall eave is
        // lowered by the parapet height), so no triangle exceeds the mapped
        // maximum by more than the 0.05 m tolerance.
        const parapetHeight =
          detail && !protectedRoute && meshed.volume.roofShape === 'flat'
            ? Math.min(
                baseStyle.parapetHeight,
                Math.max(0.08, (meshed.volume.height - meshed.volume.minHeight) * 0.08),
              )
            : 0;
        const meshedVolume =
          parapetHeight > 0.02
            ? { ...meshed.volume, height: meshed.volume.height - parapetHeight }
            : meshed.volume;
        const volumeStyle = meshed.style;

        const uStart = uCursor;
        const skippedBefore = sink.skippedTriangles;
        uCursor = addVolumeWalls(sink, meshedVolume, rings, volumeStyle, uCursor);
        addRoof(sink, meshedVolume, rings, volumeStyle, uStart, (message) => {
          warnings.push(`${label}: ${message}`);
        }, parapetHeight > 0.02 ? { parapetTop: meshed.volume.height } : {});
        if (palace) addPalaceAccents(sink, meshedVolume, rings, volumeStyle);
        const skipped = sink.skippedTriangles - skippedBefore;
        if (skipped > 0) {
          warnings.push(`${label}: ${skipped} degenerate/non-finite triangle(s) skipped`);
        }

        // Optional detail modules: dispatched only after the mandatory walls and
        // roofs exist, each in its own try/catch so a failure drops just that
        // module and keeps a correct generic base.
        if (detail && detailLevel === 'near' && !protectedRoute) {
          const context: FacadeDetailContext = {
            rings,
            volume: meshedVolume,
            allowedBounds: buildingBounds,
            floorHeight: volumeStyle.floorHeight,
            groundFloorHeight: volumeStyle.groundFloorHeight,
            bayWidth: volumeStyle.bayWidth,
            detail: true,
          };
          const runModule = (moduleName: string, run: () => number): void => {
            const before = sink.triangles;
            try {
              const emitted = run();
              const added = sink.triangles - before;
              if (added > 0) {
                detailTriangles += added;
                modulesEmitted++;
              }
              void emitted;
            } catch (error) {
              moduleFailures++;
              warnings.push(`${label}: detail module ${moduleName} failed (${describe(error)})`);
            }
          };
          if (hasDetailModule(volumeStyle, 'entrance')) {
            runModule('entrance', () => addEntranceTreatment(sink, volumeStyle, context));
          }
          if (hasDetailModule(volumeStyle, 'balconies')) {
            runModule('balconies', () => addBalconyStack(sink, volumeStyle, context));
          }
          if (hasDetailModule(volumeStyle, 'pilasters') || hasDetailModule(volumeStyle, 'cornice')) {
            runModule('facade_frame', () =>
              addFacadeFrame(sink, volumeStyle, context, {
                piers: hasDetailModule(volumeStyle, 'pilasters'),
                cornice: hasDetailModule(volumeStyle, 'cornice'),
                plinth: true,
              }),
            );
          }
          if (hasDetailModule(volumeStyle, 'roof_service')) {
            runModule('roof_service', () => addRoofService(sink, volumeStyle, context));
          }
        }
      } catch (error) {
        warnings.push(`${label}: ${describe(error)}`);
      }
    }

    // Curated landmarks: append superstructures above the regular volumes.
    if (isCityGateBuilding(building)) {
      try {
        addCityGateCrown(sink, building, style, (message) => warnings.push(`${id}: ${message}`));
      } catch (error) {
        warnings.push(`${id}: city gate crown failed (${describe(error)})`);
      }
    }
  }

  const finished = sink.finish();
  if (sink.skippedTriangles > 0) {
    warnings.push(`${sink.skippedTriangles} degenerate/non-finite triangle(s) skipped`);
  }

  const totalTriangles = finished.triangleCount;
  const geometryBytes = byteLengthOf(finished.geometry);
  // Every triangle is either mandatory source massing or optional detail; the
  // detail count is exact, so the source count is the remainder.
  const sourceCount = Math.max(0, totalTriangles - detailTriangles);

  return {
    geometry: finished.geometry,
    triangleOwner: finished.triangleOwner,
    buildingIds,
    triangleCount: totalTriangles,
    stats: {
      buildings: buildingIds.length,
      profiledBuildings,
      sourceTriangles: sourceCount,
      detailTriangles,
      totalTriangles,
      modulesEmitted,
      moduleFailures,
      geometryBytes,
    },
    warnings,
  };
}

/** Byte size of every attribute + index buffer in a merged geometry. */
function byteLengthOf(geometry: BufferGeometry): number {
  let bytes = 0;
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name) as { array?: ArrayLike<number>; itemSize?: number };
    const array = attribute?.array as ArrayLike<number> & { BYTES_PER_ELEMENT?: number } | undefined;
    if (!array) continue;
    bytes += array.length * (array.BYTES_PER_ELEMENT ?? 4);
  }
  const index = geometry.getIndex();
  if (index?.array) {
    const array = index.array as ArrayLike<number> & { BYTES_PER_ELEMENT?: number };
    bytes += array.length * (array.BYTES_PER_ELEMENT ?? 4);
  }
  return bytes;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : String(value);
}

/** Re-exported so downstream modules do not need to know which file owns it. */
export { FACE_KIND };

/** Convenience alias used by some callers / tests. */
export type BuildingStyleVector = Vec4;
