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
import { MeshSink } from './meshSink';
import {
  sanitiseDetailScale,
  styleForBuilding,
  withNoGroundBand,
  type BuildingStyle,
  type Vec4,
} from './style';
import { addVolumeWalls, boundaryRings, STREET_LEVEL_EPS, type RingInfo } from './walls';

export interface BuildingMeshOptions {
  /** Emit facade attributes (aUV/aStyle/aFace) — always written, but decorative
   * geometry (parapets, ground floor split) is only emitted when true. */
  facadeDetail: boolean;
  /** Multiplier for the window "detail scale" attribute (LOD). */
  detailScale?: number;
}

export interface BuildingMeshResult {
  geometry: BufferGeometry;
  /** One entry per triangle: index into `buildingIds`. */
  triangleOwner: Uint32Array;
  /** Stable ids parallel to triangleOwner values. */
  buildingIds: FeatureId[];
  triangleCount: number;
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
  const input: readonly BuildingFeature[] = Array.isArray(buildings) ? buildings : [];

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

    // aUV.u is continuous across the volumes of one building so window bays
    // line up where a building:part meets the base volume.
    let uCursor = 0;

    for (let volumeIndex = 0; volumeIndex < volumes.length; volumeIndex++) {
      const volume = volumes[volumeIndex];
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
        const volumeStyle =
          volume.minHeight > STREET_LEVEL_EPS ? withNoGroundBand(style) : style;

        const uStart = uCursor;
        const skippedBefore = sink.skippedTriangles;
        uCursor = addVolumeWalls(sink, volume, rings, volumeStyle, uCursor);
        addRoof(sink, volume, rings, volumeStyle, uStart, (message) => {
          warnings.push(`${label}: ${message}`);
        });
        const skipped = sink.skippedTriangles - skippedBefore;
        if (skipped > 0) {
          warnings.push(`${label}: ${skipped} degenerate/non-finite triangle(s) skipped`);
        }
      } catch (error) {
        warnings.push(`${label}: ${describe(error)}`);
      }
    }
  }

  const finished = sink.finish();
  if (sink.skippedTriangles > 0) {
    warnings.push(`${sink.skippedTriangles} degenerate/non-finite triangle(s) skipped`);
  }

  return {
    geometry: finished.geometry,
    triangleOwner: finished.triangleOwner,
    buildingIds,
    triangleCount: finished.triangleCount,
    warnings,
  };
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
