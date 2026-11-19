/**
 * Isometric Minsk — baked vehicle templates authored in Blender.
 *
 * `scripts/models/build_transport_models.py` packs the seven low-poly vehicle
 * templates into one binary payload plus a manifest:
 *
 *   public/data/mobility/vehicles/manifest.json
 *   public/data/mobility/vehicles/vehicles.bin
 *
 * Binary layout (little-endian, non-indexed triangle soup):
 *   - positions: int16 x/y/z per vertex, centimetres (`positionScale = 100`),
 *     runtime axes +X forward, +Y up, +Z right;
 *   - colours:  uint8 sRGB r/g/b per vertex, appended after all positions.
 *
 * Body panels are authored near the Minsktrans liveries; the runtime tint
 * (`instanceColor`) stays white so the baked colours survive. Failures are
 * non-fatal: the procedural fallback templates in `vehicleGeometry.ts` keep
 * the map working without the payload.
 */

import * as THREE from 'three';
import type { VehicleModel } from './vehicleGeometry';

/** Payload schema version understood by the exporter and this loader. */
export const VEHICLE_PAYLOAD_VERSION = 1;

export interface VehicleModelEntry {
  /** First vertex of this model inside the shared arrays. */
  vertexStart: number;
  /** Non-indexed vertex count (triangles × 3). */
  vertexCount: number;
  triangles: number;
  /** Metres: model bounds in runtime axes. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  lengthM: number;
  widthM: number;
  heightM: number;
}

export interface VehiclePayloadManifest {
  version: number;
  generatedAt: string;
  generator: string;
  source: string;
  /** Centimetres per metre used for int16 positions. */
  positionScale: number;
  colorSpace: 'srgb';
  axis: string;
  vertexCount: number;
  positionBytes: number;
  colorBytes: number;
  byteLength: number;
  models: Record<VehicleModel, VehicleModelEntry>;
}

export interface VehicleModelPayload {
  manifest: VehiclePayloadManifest;
  /** One non-indexed geometry per requested model; caller owns disposal. */
  geometries: Map<VehicleModel, THREE.BufferGeometry>;
}

/** Совместим с `MobilityFetchImpl`, чтобы слои могли передавать свой fetch. */
export type VehicleFetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

interface LoadOptions {
  baseUrl?: string;
  fetchImpl?: VehicleFetchImpl;
}

const DEFAULT_BASE_URL = 'data/mobility/vehicles';

function assertObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function assertNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(message);
  return value;
}

/** Parse and validate the manifest JSON (throws on contract violations). */
export function parseVehicleManifest(raw: unknown): VehiclePayloadManifest {
  const root = assertObject(raw, 'vehicle manifest must be an object');
  if (assertNumber(root.version, 'vehicle manifest.version must be a number') !== VEHICLE_PAYLOAD_VERSION) {
    throw new Error(`unsupported vehicle payload version: ${String(root.version)}`);
  }
  const positionScale = assertNumber(root.positionScale, 'vehicle manifest.positionScale must be a number');
  if (positionScale <= 0) throw new Error('vehicle manifest.positionScale must be positive');
  if (root.colorSpace !== 'srgb') throw new Error('vehicle manifest.colorSpace must be "srgb"');
  const models = assertObject(root.models, 'vehicle manifest.models must be an object');
  const parsed: Record<string, VehicleModelEntry> = {};
  for (const [name, entryRaw] of Object.entries(models)) {
    const entry = assertObject(entryRaw, `vehicle manifest.models.${name} must be an object`);
    const bounds = assertObject(entry.bounds, `vehicle manifest.models.${name}.bounds must be an object`);
    const min = assertArray(bounds.min, `vehicle manifest.models.${name}.bounds.min must be an array`);
    const max = assertArray(bounds.max, `vehicle manifest.models.${name}.bounds.max must be an array`);
    parsed[name] = {
      vertexStart: assertNumber(entry.vertexStart, `vehicle manifest.models.${name}.vertexStart must be a number`),
      vertexCount: assertNumber(entry.vertexCount, `vehicle manifest.models.${name}.vertexCount must be a number`),
      triangles: assertNumber(entry.triangles, `vehicle manifest.models.${name}.triangles must be a number`),
      bounds: {
        min: [assertNumber(min[0], 'bounds.min[0]'), assertNumber(min[1], 'bounds.min[1]'), assertNumber(min[2], 'bounds.min[2]')],
        max: [assertNumber(max[0], 'bounds.max[0]'), assertNumber(max[1], 'bounds.max[1]'), assertNumber(max[2], 'bounds.max[2]')],
      },
      lengthM: assertNumber(entry.lengthM, `vehicle manifest.models.${name}.lengthM must be a number`),
      widthM: assertNumber(entry.widthM, `vehicle manifest.models.${name}.widthM must be a number`),
      heightM: assertNumber(entry.heightM, `vehicle manifest.models.${name}.heightM must be a number`),
    };
  }
  return {
    version: VEHICLE_PAYLOAD_VERSION,
    generatedAt: String(root.generatedAt ?? ''),
    generator: String(root.generator ?? ''),
    source: String(root.source ?? ''),
    positionScale,
    colorSpace: 'srgb',
    axis: String(root.axis ?? ''),
    vertexCount: assertNumber(root.vertexCount, 'vehicle manifest.vertexCount must be a number'),
    positionBytes: assertNumber(root.positionBytes, 'vehicle manifest.positionBytes must be a number'),
    colorBytes: assertNumber(root.colorBytes, 'vehicle manifest.colorBytes must be a number'),
    byteLength: assertNumber(root.byteLength, 'vehicle manifest.byteLength must be a number'),
    models: parsed as VehiclePayloadManifest['models'],
  };
}

function srgbChannelToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Decode one model from the shared binary into a non-indexed geometry with
 * flat normals and linear vertex colours. Throws when the slice is invalid.
 */
export function createVehicleGeometryFromPayload(
  manifest: VehiclePayloadManifest,
  buffer: ArrayBuffer,
  model: VehicleModel,
): THREE.BufferGeometry {
  const entry = manifest.models[model];
  if (!entry) throw new Error(`vehicle payload has no model ${model}`);
  if (manifest.byteLength !== buffer.byteLength) {
    throw new Error(
      `vehicle payload byte length mismatch: manifest ${manifest.byteLength}, binary ${buffer.byteLength}`,
    );
  }
  const vertexCount = entry.vertexCount;
  if (!Number.isInteger(vertexCount) || vertexCount <= 0 || vertexCount % 3 !== 0) {
    throw new Error(`vehicle payload model ${model} has invalid vertex count ${vertexCount}`);
  }
  if (entry.vertexStart < 0 || entry.vertexStart + vertexCount > manifest.vertexCount) {
    throw new Error(`vehicle payload model ${model} vertex range is out of bounds`);
  }
  const scale = 1 / manifest.positionScale;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const quantized = new Int16Array(buffer, 0, manifest.vertexCount * 3);
  const palette = new Uint8Array(buffer, manifest.positionBytes, manifest.vertexCount * 3);
  for (let index = 0; index < vertexCount; index += 1) {
    const source = (entry.vertexStart + index) * 3;
    positions[index * 3] = quantized[source] * scale;
    positions[index * 3 + 1] = quantized[source + 1] * scale;
    positions[index * 3 + 2] = quantized[source + 2] * scale;
    colors[index * 3] = srgbChannelToLinear(palette[source]);
    colors[index * 3 + 1] = srgbChannelToLinear(palette[source + 1]);
    colors[index * 3 + 2] = srgbChannelToLinear(palette[source + 2]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = `mobility-vehicle-baked-${model}`;
  return geometry;
}

/**
 * Fetch manifest + binary and decode every model found in the manifest.
 * The result maps only the models the payload actually ships.
 */
export async function loadVehicleModelPayload(options: LoadOptions = {}): Promise<VehicleModelPayload> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const manifestUrl = `${base}/manifest.json`;
  const manifestResponse = await fetchImpl(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(`vehicle manifest fetch failed: ${manifestResponse.status} ${manifestUrl}`);
  }
  const manifest = parseVehicleManifest(await manifestResponse.json());
  const binaryUrl = `${base}/vehicles.bin`;
  const binaryResponse = await fetchImpl(binaryUrl);
  if (!binaryResponse.ok) {
    throw new Error(`vehicle binary fetch failed: ${binaryResponse.status} ${binaryUrl}`);
  }
  const buffer = await binaryResponse.arrayBuffer();
  const geometries = new Map<VehicleModel, THREE.BufferGeometry>();
  for (const model of Object.keys(manifest.models) as VehicleModel[]) {
    geometries.set(model, createVehicleGeometryFromPayload(manifest, buffer, model));
  }
  if (geometries.size === 0) throw new Error('vehicle payload ships no models');
  return { manifest, geometries };
}

/** Shared in-flight promise so several layers reuse one fetch. */
const payloadCache = new Map<string, Promise<VehicleModelPayload>>();

export function loadVehicleModelPayloadCached(options: LoadOptions = {}): Promise<VehicleModelPayload> {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  let promise = payloadCache.get(base);
  if (!promise) {
    promise = loadVehicleModelPayload(options).catch((error: unknown) => {
      payloadCache.delete(base);
      throw error;
    });
    payloadCache.set(base, promise);
  }
  return promise;
}

/** Test helper: forget cached loads. */
export function resetVehiclePayloadCache(): void {
  payloadCache.clear();
}
