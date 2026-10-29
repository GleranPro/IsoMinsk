/**
 * Environment mesh builder — public entry point.
 *
 * Builds the whole non-building city for one tile from the pipeline's
 * `TileData`:
 *   - `ground` : flat base quad, landcover polygons (parks, grass, forest,
 *                plaza, residential/industrial landuse, water) with holes;
 *   - `roads`  : drivable roads (tinted by `surface`), real lane markings along
 *                the OSM centreline, zebra crossings, stop lines and signal
 *                heads, medians, cycle lanes, pavements, kerbs, tram/rail
 *                ballast and rails, bridge decks with skirts/parapets/piers;
 *   - `trees`  : one merged stylised tree geometry, or null.
 *
 * Each category is a single indexed `BufferGeometry` in renderer world space
 * (`world = [localX, height, -localY]`) with vertex colours, so the tile costs
 * at most three draw calls for the entire environment.
 *
 * Layering uses `GROUND_LAYER_Y` from `src/shared/config.ts` plus a few local
 * offsets (see envLayers.ts). Nothing is ever coplanar with another category.
 *
 * Defensive by design: malformed polygons, NaN coordinates and degenerate
 * rings are skipped instead of throwing; one bad feature never breaks a tile.
 */

import * as THREE from 'three';
import { TILE_SIZE_M } from '../../shared/config';
import type { TileData } from '../../shared/types';
import type { Bounds4 } from './envLayers';
import { GeometrySink } from './meshBuilder';
import {
  createSurfaceStats,
  emitBaseGround,
  emitSurfacePolygons,
  type SurfaceBuildStats,
} from './surfaceMeshes';
import { buildTreeGeometry, type TreeDetailTier } from './treeMeshes';
import { emitAttractions, type AttractionEmitStats } from './ferrisWheel';
import { createRoadStats, emitRoadPolygons, type RoadBuildStats } from '../roads/roadMeshes';

export interface EnvironmentMeshOptions {
  /** Ground rectangle of the tile in local metres [minX, minY, maxX, maxY]. */
  tileBounds: [number, number, number, number];
  /** Emit trees (disabled at low quality). */
  trees: boolean;
}

/** Diagnostic counters; optional so the renderer contract stays unchanged. */
export interface EnvironmentMeshCounts {
  groundTriangles: number;
  roadTriangles: number;
  treeTriangles: number;
  surfaces: SurfaceBuildStats;
  roads: RoadBuildStats;
  trees: number;
  treeLod: boolean;
  /** Detail tier used for the merged tree geometry. */
  treeTier?: TreeDetailTier;
  /** Number of park attractions (ferris wheels) emitted. */
  attractions: number;
  /** Triangles in the merged attraction geometry. */
  attractionTriangles: number;
  /** Total number of polygons skipped because of malformed data. */
  skippedPolygons: number;
}

export interface EnvironmentMeshResult {
  /** Ground: base ground, landuse polygons, water surfaces. */
  ground: THREE.BufferGeometry;
  /** Roads, footways, rail surfaces. */
  roads: THREE.BufferGeometry;
  /** Tree instances (merged trunk+crown geometry) or null. */
  trees: THREE.BufferGeometry | null;
  /**
   * Park attractions (ferris wheels) as one merged geometry, or null.
   * The renderer merges this with the tree geometry (same material) — the
   * dedicated field keeps the existing ground/roads/trees contract intact.
   */
  attractions?: THREE.BufferGeometry | null;
  triangleCount: number;
  /** Extra diagnostics (optional field — the renderer may ignore it). */
  counts?: EnvironmentMeshCounts;
}

/** Emit the environment geometry for one tile. Never throws. */
export function buildEnvironmentMeshes(
  tile: TileData,
  options: EnvironmentMeshOptions,
): EnvironmentMeshResult {
  const bounds = resolveTileBounds(tile, options?.tileBounds);
  const surfaceStats = createSurfaceStats();
  const roadStats = createRoadStats();
  const groundSink = new GeometrySink();
  const roadsSink = new GeometrySink();

  try {
    emitBaseGround(groundSink, bounds);
  } catch {
    // The base quad is a single guarded quad; a failure here is unrecoverable
    // but must not take the process down.
  }

  try {
    emitSurfacePolygons(groundSink, tile?.surfaces, bounds, surfaceStats);
  } catch {
    // Emit what we have; one malformed category must not break the tile.
  }

  try {
    emitRoadPolygons(roadsSink, tile?.roads, tile?.crossings, bounds, roadStats);
  } catch {
    // Same as above.
  }

  let treeGeometry: THREE.BufferGeometry | null = null;
  let treeTriangles = 0;
  let treeCount = 0;
  let treeLod = false;
  let treeTier: EnvironmentMeshCounts['treeTier'];
  const wantTrees = options?.trees !== false;
  if (wantTrees && Array.isArray(tile?.trees) && tile.trees.length > 0) {
    try {
      const treeResult = buildTreeGeometry(tile.trees);
      if (treeResult) {
        treeGeometry = treeResult.geometry;
        treeTriangles = treeResult.triangleCount;
        treeCount = treeResult.count;
        treeLod = treeResult.lod;
        treeTier = treeResult.tier;
      }
    } catch {
      treeGeometry = null;
      treeTriangles = 0;
    }
  }

  // Park attractions (ferris wheels) — merged separately from the trees so the
  // renderer can combine them into one draw call with the tree material.
  let attractionGeometry: THREE.BufferGeometry | null = null;
  let attractionStats: AttractionEmitStats = { attractions: 0, triangles: 0, skipped: 0 };
  if (Array.isArray(tile?.attractions) && tile.attractions.length > 0) {
    try {
      const attractionSink = new GeometrySink();
      attractionStats = emitAttractions(attractionSink, tile.attractions);
      if (!attractionSink.isEmpty) {
        attractionGeometry = attractionSink.build();
      }
    } catch {
      attractionGeometry = null;
      attractionStats = { attractions: 0, triangles: 0, skipped: 0 };
    }
  }

  const ground = groundSink.build();
  const roads = roadsSink.build();
  const triangleCount =
    groundSink.triangleCount +
    roadsSink.triangleCount +
    treeTriangles +
    attractionStats.triangles;

  const counts: EnvironmentMeshCounts = {
    groundTriangles: groundSink.triangleCount,
    roadTriangles: roadsSink.triangleCount,
    treeTriangles,
    surfaces: surfaceStats,
    roads: roadStats,
    trees: treeCount,
    treeLod,
    treeTier,
    attractions: attractionStats.attractions,
    attractionTriangles: attractionStats.triangles,
    skippedPolygons: surfaceStats.skippedPolygons + roadStats.skippedPolygons,
  };

  return { ground, roads, trees: treeGeometry, attractions: attractionGeometry, triangleCount, counts };
}

/**
 * Resolve the tile footprint, preferring the renderer-provided bounds but
 * falling back to TileData.bounds and finally the tile grid.
 */
function resolveTileBounds(tile: TileData, provided: unknown): Bounds4 {
  const valid = (candidate: unknown): candidate is Bounds4 => {
    if (!Array.isArray(candidate) || candidate.length !== 4) return false;
    const [minX, minY, maxX, maxY] = candidate;
    return (
      Number.isFinite(minX) &&
      Number.isFinite(minY) &&
      Number.isFinite(maxX) &&
      Number.isFinite(maxY) &&
      maxX > minX &&
      maxY > minY
    );
  };
  if (valid(provided)) return [provided[0], provided[1], provided[2], provided[3]];
  if (valid(tile?.bounds)) return [tile.bounds[0], tile.bounds[1], tile.bounds[2], tile.bounds[3]];
  const tileX = Number.isFinite(tile?.tileX) ? tile.tileX : 0;
  const tileY = Number.isFinite(tile?.tileY) ? tile.tileY : 0;
  return [tileX * TILE_SIZE_M, tileY * TILE_SIZE_M, (tileX + 1) * TILE_SIZE_M, (tileY + 1) * TILE_SIZE_M];
}
