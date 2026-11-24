/**
 * Wire format between the tile worker and the main thread.
 *
 * Tile JSON parsing and all geometry generation happen in a Web Worker so that
 * the frame loop never blocks. `THREE.BufferGeometry` objects cannot cross the
 * worker boundary, so geometry is flattened into plain typed-array buffers
 * (transferred, not copied, when possible) and rebuilt on the main thread with
 * no further allocation beyond the BufferAttribute wrappers.
 *
 * Building meshes keep every custom facade attribute so the facade shader can
 * consume them exactly as documented in src/shared/geometry.ts.
 * Environment meshes are merged per tile into one geometry with the canonical
 * `position` / `normal` / `color` attributes.
 * Trees instead transfer two kinds of instance batches (matrices, colours,
 * variations); their indexed templates exist only on the rendering thread.
 */

import * as THREE from 'three';
import type { BuildingFeature, FeatureId } from '../../shared/types';
import { treeInstanceBytes, type TreeInstances, type TreeRenderStyle } from '../../city/environment/treeInstances';

export type TypedArrayName =
  | 'Float32Array'
  | 'Float64Array'
  | 'Uint32Array'
  | 'Uint16Array'
  | 'Uint8Array'
  | 'Int32Array'
  | 'Int16Array'
  | 'Int8Array';

export type TypedArray =
  | Float32Array
  | Float64Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | Int32Array
  | Int16Array
  | Int8Array;

type TypedArrayConstructor = {
  new (length: number): TypedArray;
  new (buffer: ArrayBufferLike): TypedArray;
  name: string;
};

const TYPED_ARRAY_CONSTRUCTORS: Record<TypedArrayName, TypedArrayConstructor> = {
  Float32Array: Float32Array as unknown as TypedArrayConstructor,
  Float64Array: Float64Array as unknown as TypedArrayConstructor,
  Uint32Array: Uint32Array as unknown as TypedArrayConstructor,
  Uint16Array: Uint16Array as unknown as TypedArrayConstructor,
  Uint8Array: Uint8Array as unknown as TypedArrayConstructor,
  Int32Array: Int32Array as unknown as TypedArrayConstructor,
  Int16Array: Int16Array as unknown as TypedArrayConstructor,
  Int8Array: Int8Array as unknown as TypedArrayConstructor,
};

function resolveTypedArrayName(name: string): TypedArrayName {
  return (name in TYPED_ARRAY_CONSTRUCTORS ? name : 'Float32Array') as TypedArrayName;
}

export interface WireAttribute {
  name: string;
  arrayType: TypedArrayName;
  itemSize: number;
  normalized: boolean;
  /** Owned ArrayBuffer, transferable. */
  data: ArrayBuffer;
}

export interface WireMesh {
  attributes: WireAttribute[];
  index: WireAttribute | null;
  /** [cx, cy, cz, radius] */
  boundingSphere: [number, number, number, number] | null;
  /** [minX, minY, minZ, maxX, maxY, maxZ] */
  boundingBox: [number, number, number, number, number, number] | null;
  triangleCount: number;
  /** Approximate byte size of all buffers, for the stats panel. */
  bytes: number;
}

/** RGBA8 ground texture of one tile; row 0 is the north edge. */
export interface WireGroundTexture {
  width: number;
  height: number;
  /** Metres per texel. */
  res: number;
  bounds: [number, number, number, number];
  /** Owned ArrayBuffer (RGBA8), transferable. */
  data: ArrayBuffer;
}

/**
 * Baked season mask of one tile (seasons P0).
 *
 * R snow depth, G leaf litter, B surface class, A wet/dirt; see
 * `paintSeasonMask` in `src/city/ground/groundRaster.ts`. Optional: old
 * payloads have no mask and the ground material falls back to a 1×1 tile.
 */
export interface WireSeasonMask {
  width: number;
  height: number;
  /** Metres per texel. */
  res: number;
  /** Owned ArrayBuffer (RGBA8), transferable. */
  data: ArrayBuffer;
}

/** How the flat ground of a tile is built. */
export type GroundBuildMode = 'raster' | 'vector';

export interface TileWirePayload {
  key: string;
  x: number;
  y: number;
  bounds: [number, number, number, number];
  buildings: BuildingFeature[];
  buildingGeometry: WireMesh | null;
  /** One index per triangle into `buildingIds`. */
  triangleOwner: ArrayBuffer | null;
  triangleOwnerLength: number;
  buildingIds: FeatureId[];
  environment: WireMesh | null;
  trees: TreeInstances | null;
  /** Explicit legacy visual/performance reference, never populated by default. */
  legacyTrees?: WireMesh | null;
  attractions?: WireMesh | null;
  /** Raster ground texture (payload 0.4.0), or null for the vector ground. */
  ground?: WireGroundTexture | null;
  /** Baked season mask for the ground texture (seasons P0), or null. */
  season?: WireSeasonMask | null;
  /** Bridge deck tops (payload 0.4.2): textured mesh + its atlas. */
  decks?: { mesh: WireMesh; texture: WireGroundTexture } | null;
  triangleCount: number;
  bytes: number;
  /** Worker-side timings, milliseconds. */
  fetchMs: number;
  buildMs: number;
  /** Non-fatal geometry-builder warning, surfaced in diagnostics only. */
  buildWarning?: string;
}

// ---------------------------------------------------------------------------
// packing (worker side)
// ---------------------------------------------------------------------------

function readAttributeComponent(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
  component: number,
): number {
  const withComponent = attribute as unknown as {
    getComponent?: (i: number, c: number) => number;
    getX?: (i: number) => number;
    getY?: (i: number) => number;
    getZ?: (i: number) => number;
    getW?: (i: number) => number;
  };
  if (typeof withComponent.getComponent === 'function') {
    return withComponent.getComponent(index, component);
  }
  switch (component) {
    case 0:
      return withComponent.getX?.(index) ?? 0;
    case 1:
      return withComponent.getY?.(index) ?? 0;
    case 2:
      return withComponent.getZ?.(index) ?? 0;
    default:
      return withComponent.getW?.(index) ?? 0;
  }
}

function packAttribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): WireAttribute {
  const itemSize = attribute.itemSize;
  const count = attribute.count;
  const interleaved =
    (attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true;
  let data: ArrayBuffer;
  let arrayType: TypedArrayName;

  if (!interleaved) {
    const source = (attribute as THREE.BufferAttribute).array as unknown as TypedArray;
    const constructorName = (source as unknown as { constructor?: { name?: string } }).constructor
      ?.name;
    arrayType = resolveTypedArrayName(constructorName ?? 'Float32Array');
    const Ctor = TYPED_ARRAY_CONSTRUCTORS[arrayType];
    const copy = new Ctor(source.length);
    copy.set(source as never);
    data = copy.buffer as ArrayBuffer;
  } else {
    // Interleaved attributes are de-interleaved into a plain Float32 buffer.
    arrayType = 'Float32Array';
    const copy = new Float32Array(count * itemSize);
    for (let i = 0; i < count; i += 1) {
      const base = i * itemSize;
      for (let c = 0; c < itemSize; c += 1) {
        copy[base + c] = readAttributeComponent(attribute, i, c);
      }
    }
    data = copy.buffer as ArrayBuffer;
  }

  return {
    name: attribute.name || '',
    arrayType,
    itemSize,
    normalized: Boolean(attribute.normalized),
    data,
  };
}

export function packGeometry(geometry: THREE.BufferGeometry): WireMesh {
  const attributes: WireAttribute[] = [];
  for (const name of Object.keys(geometry.attributes)) {
    const packed = packAttribute(geometry.attributes[name]);
    // THREE.BufferAttribute does not know its own name (setAttribute stores it
    // only in the geometry's map), so the name must always come from the key.
    packed.name = name;
    attributes.push(packed);
  }

  const indexAttribute = geometry.getIndex();
  const index = indexAttribute ? packAttribute(indexAttribute) : null;

  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  if (!geometry.boundingBox) geometry.computeBoundingBox();

  const sphere = geometry.boundingSphere;
  const box = geometry.boundingBox;
  const position = geometry.getAttribute('position');
  const triangleCount = indexAttribute
    ? indexAttribute.count / 3
    : position
      ? position.count / 3
      : 0;

  const bytes = attributes.reduce((sum, attribute) => sum + attribute.data.byteLength, 0)
    + (index ? index.data.byteLength : 0);

  return {
    attributes,
    index,
    boundingSphere: sphere ? [sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius] : null,
    boundingBox: box
      ? [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]
      : null,
    triangleCount,
    bytes,
  };
}

/** Copy a Uint32Array into an exact-sized transferable buffer. */
export function packUint32Array(source: Uint32Array): ArrayBuffer {
  const copy = new Uint32Array(source.length);
  copy.set(source);
  return copy.buffer as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// unpacking (main thread)
// ---------------------------------------------------------------------------

export function unpackGeometry(mesh: WireMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const attribute of mesh.attributes) {
    if (!attribute.name) continue;
    const Ctor = TYPED_ARRAY_CONSTRUCTORS[resolveTypedArrayName(attribute.arrayType)];
    const array = new Ctor(attribute.data);
    geometry.setAttribute(
      attribute.name,
      new THREE.BufferAttribute(array, attribute.itemSize, attribute.normalized),
    );
  }
  if (mesh.index) {
    const Ctor = TYPED_ARRAY_CONSTRUCTORS[resolveTypedArrayName(mesh.index.arrayType)];
    geometry.setIndex(new THREE.BufferAttribute(new Ctor(mesh.index.data), 1));
  }
  if (mesh.boundingSphere) {
    const [cx, cy, cz, radius] = mesh.boundingSphere;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), radius);
  } else {
    geometry.computeBoundingSphere();
  }
  if (mesh.boundingBox) {
    const [minX, minY, minZ, maxX, maxY, maxZ] = mesh.boundingBox;
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
  } else {
    geometry.computeBoundingBox();
  }
  return geometry;
}

export function wireMeshBytes(mesh: WireMesh | null): number {
  return mesh ? mesh.bytes : 0;
}

// ---------------------------------------------------------------------------
// worker message protocol
// ---------------------------------------------------------------------------

export interface TileWorkerLoadRequest {
  type: 'load';
  id: number;
  key: string;
  url: string;
  facadeDetail: boolean;
  trees: boolean;
  treeStyle?: TreeRenderStyle;
  groundMode?: GroundBuildMode;
  /** Ground texel size override, metres (default: by tile size). */
  groundRes?: number;
  /** Build only the ground texture and bridge decks (ground LOD upgrade). */
  groundOnly?: boolean;
}

export interface TileWorkerCancelRequest {
  type: 'cancel';
  id: number;
}

export type TileWorkerRequest = TileWorkerLoadRequest | TileWorkerCancelRequest;

export interface TileWorkerResultMessage {
  type: 'result';
  id: number;
  payload: TileWirePayload;
}

export interface TileWorkerErrorMessage {
  type: 'error';
  id: number;
  message: string;
}

export interface TileWorkerCancelledMessage {
  type: 'cancelled';
  id: number;
}

export type TileWorkerResponse =
  | TileWorkerResultMessage
  | TileWorkerErrorMessage
  | TileWorkerCancelledMessage;

/** Every transferable buffer referenced by a payload (for postMessage). */
export function collectTransferables(payload: TileWirePayload): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  const addMesh = (mesh: WireMesh | null) => {
    if (!mesh) return;
    for (const attribute of mesh.attributes) buffers.push(attribute.data);
    if (mesh.index) buffers.push(mesh.index.data);
  };
  addMesh(payload.buildingGeometry);
  addMesh(payload.environment);
  addMesh(payload.legacyTrees ?? null);
  addMesh(payload.attractions ?? null);
  if (payload.trees) {
    for (const batch of [payload.trees.trunks, ...payload.trees.crowns]) {
      buffers.push(batch.matrices.buffer as ArrayBuffer, batch.colors.buffer as ArrayBuffer,
        batch.variations.buffer as ArrayBuffer);
    }
  }
  if (payload.ground?.data) buffers.push(payload.ground.data);
  if (payload.season?.data) buffers.push(payload.season.data);
  if (payload.decks) {
    addMesh(payload.decks.mesh);
    buffers.push(payload.decks.texture.data);
  }
  if (payload.triangleOwner) buffers.push(payload.triangleOwner);
  return buffers;
}

export function payloadBytes(payload: TileWirePayload): number {
  return (
    wireMeshBytes(payload.buildingGeometry) +
    wireMeshBytes(payload.environment) +
    treeInstanceBytes(payload.trees) +
    wireMeshBytes(payload.legacyTrees ?? null) +
    wireMeshBytes(payload.attractions ?? null) +
    (payload.ground?.data.byteLength ?? 0) +
    (payload.season?.data.byteLength ?? 0) +
    (payload.decks ? wireMeshBytes(payload.decks.mesh) + payload.decks.texture.data.byteLength : 0) +
    (payload.triangleOwner ? payload.triangleOwner.byteLength : 0)
  );
}
