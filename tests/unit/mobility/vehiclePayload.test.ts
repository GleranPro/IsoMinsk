/**
 * Blender-модели транспорта: контракт бинарного payload.
 *
 * Синтетический буфер проверяет декодирование без сети, а реальный
 * `public/data/mobility/vehicles` — то, что в репозиторий попал корректный
 * экспорт (int16-сантиметры + uint8 sRGB, 7 моделей, бюджеты треугольников).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  VEHICLE_PAYLOAD_VERSION,
  createVehicleGeometryFromPayload,
  parseVehicleManifest,
  type VehiclePayloadManifest,
} from '../../../src/city/mobility/vehiclePayload';
import {
  VEHICLE_MODELS,
  VEHICLE_TRIANGLE_BUDGET,
  type VehicleModel,
} from '../../../src/city/mobility/vehicleGeometry';

interface SyntheticPayload {
  manifest: VehiclePayloadManifest;
  buffer: ArrayBuffer;
}

function packSynthetic(
  positionsCm: readonly [number, number, number][],
  colors: readonly [number, number, number][],
  model: VehicleModel = 'bus',
): SyntheticPayload {
  const vertexCount = positionsCm.length;
  const positions = new Int16Array(vertexCount * 3);
  positionsCm.forEach((value, index) => {
    positions[index * 3] = value[0];
    positions[index * 3 + 1] = value[1];
    positions[index * 3 + 2] = value[2];
  });
  const palette = new Uint8Array(vertexCount * 3);
  colors.forEach((value, index) => {
    palette[index * 3] = value[0];
    palette[index * 3 + 1] = value[1];
    palette[index * 3 + 2] = value[2];
  });
  const positionBytes = positions.byteLength;
  const colorBytes = palette.byteLength;
  const buffer = new ArrayBuffer(positionBytes + colorBytes);
  new Int16Array(buffer, 0, positions.length).set(positions);
  new Uint8Array(buffer, positionBytes, palette.length).set(palette);
  const manifest: VehiclePayloadManifest = {
    version: VEHICLE_PAYLOAD_VERSION,
    generatedAt: '2026-11-18T00:00:00Z',
    generator: 'test',
    source: 'test',
    positionScale: 100,
    colorSpace: 'srgb',
    axis: 'runtime: +X forward, +Y up, +Z right',
    vertexCount,
    positionBytes,
    colorBytes,
    byteLength: buffer.byteLength,
    models: {
      [model]: {
        vertexStart: 0,
        vertexCount,
        triangles: vertexCount / 3,
        bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        lengthM: 1,
        widthM: 0,
        heightM: 1,
      },
    } as VehiclePayloadManifest['models'],
  };
  return { manifest, buffer };
}

describe('vehicle payload', () => {
  it('decodes int16 centimetres and uint8 sRGB into metres and linear colours', () => {
    const { manifest, buffer } = packSynthetic(
      [
        [0, 0, 0],
        [100, 0, 0],
        [0, 100, 0],
      ],
      [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ],
    );
    const geometry = createVehicleGeometryFromPayload(manifest, buffer, 'bus');
    const position = geometry.getAttribute('position').array as Float32Array;
    expect(Array.from(position)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const color = geometry.getAttribute('color').array as Float32Array;
    expect(color[0]).toBeCloseTo(1, 5);
    expect(color[1]).toBeCloseTo(0, 5);
    expect(color[4]).toBeCloseTo(1, 5);
    expect(color[8]).toBeCloseTo(1, 5);
    const box = geometry.boundingBox as THREE.Box3;
    expect(box.min.toArray()).toEqual([0, 0, 0]);
    expect(box.max.toArray()).toEqual([1, 1, 0]);
    const normals = geometry.getAttribute('normal').array as Float32Array;
    for (let index = 0; index < normals.length; index += 3) {
      expect(Math.hypot(normals[index], normals[index + 1], normals[index + 2])).toBeCloseTo(1, 4);
    }
    geometry.dispose();
  });

  it('rejects an unsupported version, a wrong colour space and a truncated binary', () => {
    expect(() =>
      parseVehicleManifest({
        version: 99,
        positionScale: 100,
        colorSpace: 'srgb',
        models: {},
        vertexCount: 0,
        positionBytes: 0,
        colorBytes: 0,
        byteLength: 0,
      }),
    ).toThrow(/version/);
    expect(() =>
      parseVehicleManifest({
        version: 1,
        positionScale: 100,
        colorSpace: 'linear',
        models: {},
        vertexCount: 0,
        positionBytes: 0,
        colorBytes: 0,
        byteLength: 0,
      }),
    ).toThrow(/colorSpace/);
    const { manifest, buffer } = packSynthetic(
      [
        [0, 0, 0],
        [100, 0, 0],
        [0, 100, 0],
      ],
      [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ],
    );
    expect(() => createVehicleGeometryFromPayload(manifest, buffer.slice(0, 4), 'bus')).toThrow(
      /byte length/,
    );
    expect(() => createVehicleGeometryFromPayload(manifest, buffer, 'tram')).toThrow(/no model/);
  });

  it('ships a valid baked fleet on disk with all seven templates', () => {
    const base = resolve(process.cwd(), 'public', 'data', 'mobility', 'vehicles');
    const manifestPath = resolve(base, 'manifest.json');
    if (!existsSync(manifestPath)) {
      // Payload is generated by `pnpm run models:transport`; the app falls
      // back to procedural templates without it. Do not fake a fixture here.
      expect(existsSync(manifestPath)).toBe(false);
      return;
    }
    const manifest = parseVehicleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    const buffer = readFileSync(resolve(base, 'vehicles.bin'));
    const array = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    expect(manifest.vertexCount).toBeGreaterThan(1000);
    expect(manifest.positionBytes).toBe(manifest.vertexCount * 6);
    expect(manifest.colorBytes).toBe(manifest.vertexCount * 3);
    expect(manifest.byteLength).toBe(array.byteLength);
    for (const model of VEHICLE_MODELS) {
      const entry = manifest.models[model];
      expect(entry, model).toBeDefined();
      expect(entry.triangles, model).toBeGreaterThan(100);
      expect(entry.triangles, model).toBeLessThanOrEqual(VEHICLE_TRIANGLE_BUDGET[model]);
      expect(entry.vertexCount, model).toBe(entry.triangles * 3);
      const geometry = createVehicleGeometryFromPayload(manifest, array, model);
      const box = geometry.boundingBox as THREE.Box3;
      expect(box.min.y, model).toBeGreaterThanOrEqual(-0.01);
      expect(box.min.y, model).toBeLessThan(0.02);
      expect(box.max.x - box.min.x, model).toBeCloseTo(entry.lengthM, 1);
      expect(box.max.z - box.min.z, model).toBeCloseTo(entry.widthM, 1);
      const colors = geometry.getAttribute('color').array as Float32Array;
      let dark = 0;
      let light = 0;
      for (let index = 0; index < colors.length; index += 3) {
        if (colors[index] + colors[index + 1] + colors[index + 2] < 0.4) dark += 1;
        if (colors[index] + colors[index + 1] + colors[index + 2] > 1.2) light += 1;
      }
      expect(dark, model).toBeGreaterThan(0);
      // Полувагон тёмный (бурая обшивка и уголь); светлые детали есть у
      // остальных шаблонов — фар, стёкол, белых полос.
      if (model !== 'freightWagon') expect(light, model).toBeGreaterThan(0);
      geometry.dispose();
    }
  });
});
