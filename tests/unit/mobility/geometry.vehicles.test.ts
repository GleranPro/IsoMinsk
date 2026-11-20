/**
 * Геометрия транспорта: бюджет треугольников, габариты, ориентация,
 * детерминизм и lifecycle шаблонов/инстанс-батчей. WebGL не требуется:
 * three.js создаёт BufferGeometry и InstancedMesh в node.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  MOBILITY_LIVERY,
  VEHICLE_DIMENSIONS,
  VEHICLE_MODELS,
  VEHICLE_TRIANGLE_BUDGET,
  VehicleTemplateCache,
  createVehicleInstances,
  createVehicleTemplate,
  disposeVehicleInstances,
  vehicleBounds,
  vehicleLiveryHex,
  vehicleTintColor,
} from '../../../src/city/mobility/vehicleGeometry';

function signedVolume(geometry: THREE.BufferGeometry): number {
  const positions = geometry.getAttribute('position').array as Float32Array;
  let volume = 0;
  for (let index = 0; index + 8 < positions.length; index += 9) {
    const ax = positions[index];
    const ay = positions[index + 1];
    const az = positions[index + 2];
    const bx = positions[index + 3];
    const by = positions[index + 4];
    const bz = positions[index + 5];
    const cx = positions[index + 6];
    const cy = positions[index + 7];
    const cz = positions[index + 8];
    volume +=
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx);
  }
  return volume / 6;
}

describe('vehicle geometry', () => {
  it('keeps every model inside the low-poly triangle budget', () => {
    for (const model of VEHICLE_MODELS) {
      const geometry = createVehicleTemplate(model);
      const triangles = geometry.getAttribute('position').count / 3;
      expect(triangles, model).toBeGreaterThan(80);
      expect(triangles, model).toBeLessThanOrEqual(VEHICLE_TRIANGLE_BUDGET[model]);
      expect(geometry.index, model).toBeNull();
      geometry.dispose();
    }
  });

  it('uses plausible lengths (bus ~12 m, tram ~15 m) and rests on y = 0', () => {
    for (const model of VEHICLE_MODELS) {
      const bounds = vehicleBounds(model);
      const dimensions = VEHICLE_DIMENSIONS[model];
      expect(Math.abs(bounds.lengthM - dimensions.lengthM), model).toBeLessThan(0.1);
      expect(Math.abs(bounds.widthM - dimensions.widthM), model).toBeLessThan(0.15);
      expect(bounds.minY, model).toBeGreaterThanOrEqual(0);
      expect(bounds.minY, model).toBeLessThan(0.02);
      expect(bounds.heightM, model).toBeGreaterThan(2.9);
    }
  });

  it('orients +X as travel and centres the body on the local origin', () => {
    for (const model of VEHICLE_MODELS) {
      const geometry = createVehicleTemplate(model);
      const box = geometry.boundingBox as THREE.Box3;
      expect(box.min.x, model).toBeLessThan(-5);
      expect(box.max.x, model).toBeGreaterThan(5);
      expect(Math.abs(box.max.x + box.min.x), model).toBeLessThan(0.1);
      expect(box.max.z - box.min.z, model).toBeLessThan(3);
      geometry.dispose();
    }
  });

  it('orients closed surfaces outwards (positive signed volume, finite normals)', () => {
    for (const model of VEHICLE_MODELS) {
      const geometry = createVehicleTemplate(model);
      const volume = signedVolume(geometry);
      expect(volume, model).toBeGreaterThan(20);
      const normals = geometry.getAttribute('normal').array as Float32Array;
      for (let index = 0; index < normals.length; index += 3) {
        const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]);
        expect(length, model).toBeCloseTo(1, 4);
      }
      geometry.dispose();
    }
  });

  it('builds byte-identical templates on repeated calls (determinism)', () => {
    for (const model of VEHICLE_MODELS) {
      const first = createVehicleTemplate(model);
      const second = createVehicleTemplate(model);
      const firstPosition = first.getAttribute('position').array as Float32Array;
      const secondPosition = second.getAttribute('position').array as Float32Array;
      expect(firstPosition.length, model).toBe(secondPosition.length);
      expect(Array.from(firstPosition), model).toEqual(Array.from(secondPosition));
      expect(
        Array.from(first.getAttribute('color').array as Float32Array),
        model,
      ).toEqual(Array.from(second.getAttribute('color').array as Float32Array));
      first.dispose();
      second.dispose();
    }
  });

  it('stores linear vertex colours, keeps body faces nearly white for the livery tint', () => {
    const geometry = createVehicleTemplate('bus');
    const colors = geometry.getAttribute('color').array as Float32Array;
    let bodyVertices = 0;
    for (let index = 0; index < colors.length; index += 3) {
      const r = colors[index];
      const g = colors[index + 1];
      const b = colors[index + 2];
      for (const channel of [r, g, b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
      if (r > 0.98 && g > 0.98 && b > 0.98) bodyVertices += 1;
    }
    // Борта и передний торец оставлены белыми, чтобы instanceColor задавал ливрею.
    expect(bodyVertices).toBeGreaterThan(20);
    geometry.dispose();
  });

  it('uses a limited, deterministic livery palette', () => {
    const all = new Set<string>();
    for (const model of VEHICLE_MODELS) {
      expect(MOBILITY_LIVERY[model].length).toBeLessThanOrEqual(3);
      for (const hex of MOBILITY_LIVERY[model]) all.add(hex);
      expect(vehicleLiveryHex(model, 'trip-42')).toBe(vehicleLiveryHex(model, 'trip-42'));
      expect(MOBILITY_LIVERY[model]).toContain(vehicleLiveryHex(model, 'trip-42'));
    }
    expect(all.size).toBeLessThanOrEqual(9);
    const tint = vehicleTintColor('tram', 'trip-42');
    expect(tint).toBeInstanceOf(THREE.Color);
    expect(tint.r).toBeGreaterThanOrEqual(0);
    expect(tint.r).toBeLessThanOrEqual(1);
  });

  it('caches and disposes shared templates', () => {
    const cache = new VehicleTemplateCache();
    const disposed: string[] = [];
    for (const model of VEHICLE_MODELS) {
      const geometry = cache.get(model);
      const original = geometry.dispose.bind(geometry);
      geometry.dispose = () => {
        disposed.push(model);
        original();
      };
    }
    expect(cache.get('bus')).toBe(cache.get('bus'));
    expect(cache.size).toBe(VEHICLE_MODELS.length);
    expect(cache.triangleCount('bus')).toBeGreaterThan(0);
    expect(cache.bytes).toBeGreaterThan(0);
    cache.dispose();
    expect(cache.size).toBe(0);
    expect(disposed.sort()).toEqual([...VEHICLE_MODELS].sort());
  });

  it('creates instance batches with dynamic buffers and releases them', () => {
    const cache = new VehicleTemplateCache();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = createVehicleInstances(cache.get('tram'), 7, material, 'tram');
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
    expect(mesh.instanceMatrix.count).toBe(7);
    expect(mesh.instanceMatrix.usage).toBe(THREE.DynamicDrawUsage);
    expect(mesh.instanceColor).not.toBeNull();
    expect(mesh.instanceColor?.count).toBe(7);
    expect(mesh.castShadow).toBe(false);
    mesh.count = 3;
    disposeVehicleInstances(mesh);
    expect(mesh.count).toBe(0);
    expect(mesh.instanceColor).toBeNull();
    // Шаблон принадлежит кешу: после освобождения батча он ещё жив.
    expect(cache.get('tram').getAttribute('position').count).toBeGreaterThan(0);
    cache.dispose();
    material.dispose();
  });
});
