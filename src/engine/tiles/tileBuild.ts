/**
 * Tile -> render payload.
 *
 * Runs inside the tile worker (and as an inline fallback on the main thread):
 * calls the city geometry builders, merges static ground/road layers and packs
 * separate compact tree instances and attraction geometry into transferable buffers.
 *
 * World-space convention: geometry builders already emit world coordinates
 * (x east, y up, z = -north), so nothing here re-projects points.
 */

import * as THREE from 'three';
import { buildBuildingsMesh } from '../../city/buildings/buildingsMesh';
import { buildEnvironmentMeshes } from '../../city/environment/environmentMeshes';
import { collectLampSpots } from '../../city/environment/lampSpots';
import { LANDMARK_HIDDEN_BUILDING_IDS } from '../../shared/landmarks';
import type { TileData } from '../../shared/types';
import type { TreeRenderStyle } from '../../city/environment/treeInstances';
import {
  groundRasterAvailable,
  groundResolutionFor,
  hasGroundLayer,
  rasterizeGround,
} from '../../city/ground/groundRaster';
import {
  buildDeckTopGeometry,
  rasterizeDecks,
  tileDecks,
  usesGroundDecks,
} from '../../city/ground/groundDecks';
import {
  type GroundBuildMode,
  type WireGroundTexture,
  packGeometry,
  packUint32Array,
  payloadBytes,
  type TileWirePayload,
  type WireMesh,
} from './serialization';

export interface TileBuildOptions {
  facadeDetail: boolean;
  trees: boolean;
  treeStyle?: TreeRenderStyle;
  /** 'raster' (default) paints the flat ground into a texture when possible. */
  groundMode?: GroundBuildMode;
  /** Ground texel size override, metres. */
  groundRes?: number;
  /** Ground texture + bridge decks only (ground LOD upgrade of a loaded tile). */
  groundOnly?: boolean;
}

interface ExtractedPart {
  positions: Float32Array;
  colors: Float32Array | null;
  colorAttributeName: string;
  vertexCount: number;
}

function attributeToFloat3(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  count: number,
  itemSize: number,
): Float32Array {
  const output = new Float32Array(count * 3);
  const read = (i: number, c: number): number => {
    const anyAttribute = attribute as unknown as {
      getComponent?: (index: number, component: number) => number;
      getX?: (index: number) => number;
      getY?: (index: number) => number;
      getZ?: (index: number) => number;
      array?: ArrayLike<number>;
      itemSize?: number;
      isInterleavedBufferAttribute?: boolean;
    };
    if (typeof anyAttribute.getComponent === 'function') {
      return anyAttribute.getComponent(i, c);
    }
    if (!anyAttribute.isInterleavedBufferAttribute && anyAttribute.array) {
      const stride = anyAttribute.itemSize ?? attribute.itemSize;
      return anyAttribute.array[i * stride + c] ?? 0;
    }
    if (c === 0) return anyAttribute.getX?.(i) ?? 0;
    if (c === 1) return anyAttribute.getY?.(i) ?? 0;
    if (c === 2) return anyAttribute.getZ?.(i) ?? 0;
    return 0;
  };
  const channels = Math.max(1, Math.min(itemSize, 3));
  for (let i = 0; i < count; i += 1) {
    const base = i * 3;
    for (let c = 0; c < channels; c += 1) output[base + c] = read(i, c);
    if (channels < 3) output[base + 2] = 0;
  }
  return output;
}

function extractPart(geometry: THREE.BufferGeometry): ExtractedPart | null {
  let source: THREE.BufferGeometry = geometry;
  if (geometry.getIndex()) {
    // Merging works on flat (non-indexed) vertex streams; this also guarantees
    // every triangle gets a per-face normal after computeVertexNormals().
    try {
      source = geometry.toNonIndexed();
    } catch {
      source = geometry;
    }
  }

  const position = source.getAttribute('position');
  if (!position) return null;
  const count = position.count;
  if (count === 0) return null;

  const positions = attributeToFloat3(position as THREE.BufferAttribute, count, 3);

  const aColor = source.getAttribute('aColor');
  const color = source.getAttribute('color');
  const colorAttribute = aColor ?? color;
  const colorAttributeName = aColor ? 'aColor' : color ? 'color' : '';
  const colors = colorAttribute
    ? attributeToFloat3(
        colorAttribute as THREE.BufferAttribute,
        count,
        colorAttribute.itemSize,
      )
    : null;

  return { positions, colors, colorAttributeName, vertexCount: count };
}

/**
 * Merge environment meshes into ONE geometry with position/normal/colour.
 * The canonical `color` attribute name is used for `color` sources while
 * `aColor` sources keep their name so the environment material can apply the
 * sRGB vs linear convention the geometry builder intended.
 */
export function mergeEnvironmentGeometries(
  parts: Array<THREE.BufferGeometry | null | undefined>,
): THREE.BufferGeometry | null {
  const extracted: ExtractedPart[] = [];
  for (const part of parts) {
    if (!part) continue;
    try {
      const next = extractPart(part);
      if (next) extracted.push(next);
    } catch (error) {
      console.warn('[renderer] failed to merge an environment mesh', error);
    }
  }
  if (extracted.length === 0) return null;

  let totalVertices = 0;
  for (const part of extracted) totalVertices += part.vertexCount;

  const positions = new Float32Array(totalVertices * 3);
  let colorAttributeName = extracted.find((part) => part.colors)?.colorAttributeName ?? '';
  const hasColors = colorAttributeName !== '';
  const colors = hasColors ? new Float32Array(totalVertices * 3) : null;

  let offset = 0;
  for (const part of extracted) {
    positions.set(part.positions, offset * 3);
    if (colors) {
      if (part.colors) {
        colors.set(part.colors, offset * 3);
      } else {
        // Mixed sources: fill white so the part is lit by the material colour.
        colors.fill(1, offset * 3, (offset + part.vertexCount) * 3);
      }
    }
    offset += part.vertexCount;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors) merged.setAttribute(colorAttributeName, new THREE.Float32BufferAttribute(colors, 3));
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/** Build the complete render payload for one tile (worker side). */
export function buildTilePayload(data: TileData, options: TileBuildOptions): TileWirePayload {
  const startedAt = now();
  let buildingsError = '';

  // Raster ground (payload 0.4.0): one texture for base/landcover/roads/paths.
  let ground: WireGroundTexture | null = null;
  if (
    (options.groundMode ?? 'raster') === 'raster' &&
    hasGroundLayer(data) &&
    groundRasterAvailable()
  ) {
    try {
      const size = Math.max(1, data.bounds[2] - data.bounds[0]);
      const raster = rasterizeGround(data, data.bounds, groundResolutionFor(size, options.groundRes));
      if (raster) {
        const copy = new Uint8Array(raster.data.byteLength);
        copy.set(raster.data);
        ground = {
          width: raster.width,
          height: raster.height,
          res: raster.res,
          bounds: raster.bounds,
          data: copy.buffer,
        };
      }
    } catch (error) {
      buildingsError = `ground raster: ${String(error)}`;
      ground = null;
    }
  }

  // Bridge decks (payload 0.4.2): textured top surface, painted like the ground.
  let decks: TileWirePayload['decks'] = null;
  if (ground && usesGroundDecks(data)) {
    try {
      const list = tileDecks(data);
      const atlas = rasterizeDecks(list, ground.res);
      const geometry = atlas ? buildDeckTopGeometry(list, atlas) : null;
      if (atlas && geometry) {
        const copy = new Uint8Array(atlas.data.byteLength);
        copy.set(atlas.data);
        decks = {
          mesh: packGeometry(geometry),
          texture: {
            width: atlas.width,
            height: atlas.height,
            res: atlas.res,
            bounds: data.bounds,
            data: copy.buffer,
          },
        };
      }
    } catch (error) {
      buildingsError = `bridge decks: ${String(error)}`;
      decks = null;
    }
  }

  if (options.groundOnly) {
    const groundPayload: TileWirePayload = {
      key: `${data.tileX}_${data.tileY}`,
      x: data.tileX,
      y: data.tileY,
      bounds: data.bounds,
      buildings: [],
      buildingGeometry: null,
      triangleOwner: null,
      triangleOwnerLength: 0,
      buildingIds: [],
      environment: null,
      trees: null,
      ground,
      decks,
      triangleCount: decks ? decks.mesh.triangleCount : 0,
      bytes: 0,
      fetchMs: 0,
      buildMs: 0,
    };
    groundPayload.bytes = payloadBytes(groundPayload);
    groundPayload.buildMs = now() - startedAt;
    if (buildingsError) groundPayload.buildWarning = buildingsError;
    return groundPayload;
  }

  const environment = (() => {
    try {
      const result = buildEnvironmentMeshes(data, {
        tileBounds: data.bounds,
        trees: options.trees,
        treeStyle: options.treeStyle,
        rasterGround: ground !== null,
      });
      const merged = mergeEnvironmentGeometries([result.ground, result.roads]);
      // Attractions must not inherit foliage colour or visibility changes.
      const legacyTrees = result.trees ? mergeEnvironmentGeometries([result.trees]) : null;
      return { merged, legacyTrees, trees: result.treeInstances ?? null, attractions: result.attractions ?? null };
    } catch (error) {
      buildingsError = `environment: ${String(error)}`;
      return { merged: null, legacyTrees: null, trees: null, attractions: null };
    }
  })();

  let buildingGeometry: WireMesh | null = null;
  let triangleOwner: ArrayBuffer | null = null;
  let triangleOwnerLength = 0;
  let buildingIds: string[] = [];

  try {
    const result = buildBuildingsMesh(data.buildings, {
      facadeDetail: options.facadeDetail,
      hiddenBuildingIds: LANDMARK_HIDDEN_BUILDING_IDS,
    });
    triangleOwnerLength = result.triangleOwner ? result.triangleOwner.length : 0;
    if (result.triangleCount > 0 && result.geometry.getAttribute('position')) {
      buildingGeometry = packGeometry(result.geometry);
      triangleOwner = result.triangleOwner
        ? packUint32Array(
            result.triangleOwner instanceof Uint32Array
              ? result.triangleOwner
              : Uint32Array.from(result.triangleOwner as ArrayLike<number>),
          )
        : null;
      buildingIds = result.buildingIds ?? [];
    } else {
      triangleOwnerLength = 0;
    }
  } catch (error) {
    buildingsError = `buildings: ${String(error)}`;
    buildingGeometry = null;
    triangleOwner = null;
    triangleOwnerLength = 0;
    buildingIds = [];
  }

  const environmentMesh = environment.merged ? packGeometry(environment.merged) : null;

  // Street lamp spots for the night layer: cheap stroke walk in the worker,
  // engine only uploads them into one instanced batch.
  let lamps: ArrayBuffer | null = null;
  try {
    const spots = collectLampSpots(data);
    if (spots) lamps = spots.buffer as ArrayBuffer;
  } catch {
    lamps = null;
  }
  const legacyTrees = environment.legacyTrees ? packGeometry(environment.legacyTrees) : null;
  const attractions = environment.attractions ? packGeometry(environment.attractions) : null;
  const triangleCount =
    (buildingGeometry ? buildingGeometry.triangleCount : 0) +
    (environmentMesh ? environmentMesh.triangleCount : 0) +
    (legacyTrees?.triangleCount ?? 0) + (environment.trees?.triangleCount ?? 0) +
    (attractions?.triangleCount ?? 0);

  const payload: TileWirePayload = {
    key: `${data.tileX}_${data.tileY}`,
    x: data.tileX,
    y: data.tileY,
    bounds: data.bounds,
    buildings: data.buildings ?? [],
    buildingGeometry,
    triangleOwner,
    triangleOwnerLength,
    buildingIds,
    environment: environmentMesh,
    trees: environment.trees,
    legacyTrees,
    attractions,
    ground,
    decks,
    lamps,
    triangleCount,
    bytes: 0,
    fetchMs: 0,
    buildMs: 0,
  };
  payload.bytes = payloadBytes(payload);
  payload.buildMs = now() - startedAt;
  if (buildingsError) {
    // Surface the failure in the payload for diagnostics without throwing away
    // the rest of the tile (ground/roads still render).
    payload.buildWarning = buildingsError;
  }
  return payload;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
