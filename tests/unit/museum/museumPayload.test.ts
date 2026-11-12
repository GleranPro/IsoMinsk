/**
 * Lipki museum payload contract.
 *
 * Guards the hand-off between `scripts/qa/export_museum_web.py` and the scene
 * layer: binary layout, manifest bookkeeping and the real exported files.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMuseumGeometry, type MuseumManifest } from '../../../src/engine/museum/museumLayer';

function writeSynthetic(vertices: { x: number; z: number; y: number; r: number; g: number; b: number }[]) {
  const count = vertices.length;
  const buffer = new ArrayBuffer(count * 9);
  const xs = new Int16Array(buffer, 0, count);
  const zs = new Int16Array(buffer, count * 2, count);
  const ys = new Int16Array(buffer, count * 4, count);
  const rgb = new Uint8Array(buffer, count * 6, count * 3);
  vertices.forEach((v, index) => {
    xs[index] = v.x;
    zs[index] = v.z;
    ys[index] = v.y;
    rgb[index * 3] = v.r;
    rgb[index * 3 + 1] = v.g;
    rgb[index * 3 + 2] = v.b;
  });
  const manifest: MuseumManifest = {
    version: 1,
    origin: [9300, 650],
    positionScale: 10,
    vertices: count,
    triangles: Math.floor(count / 3),
    byteLength: buffer.byteLength,
    sections: [],
    exhibits: [],
    missing: [],
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  };
  return { manifest, buffer };
}

describe('museum payload', () => {
  it('maps int16 decimetres to world metres (x east, y up, -y north)', () => {
    const { manifest, buffer } = writeSynthetic([
      { x: 10, z: 25, y: 40, r: 255, g: 0, b: 0 },
      { x: -10, z: 0, y: -40, r: 0, g: 255, b: 0 },
      { x: 0, z: 5, y: 0, r: 0, g: 0, b: 255 },
    ]);
    const geometry = createMuseumGeometry(manifest, buffer);
    const position = geometry.getAttribute('position');
    const xyz = Array.from(position.array).map((value) => (Object.is(value, -0) ? 0 : value));
    expect(xyz).toEqual([1, 2.5, -4, -1, 0, 4, 0, 0.5, 0]);
    const color = geometry.getAttribute('color');
    expect(color.array[0]).toBeCloseTo(1, 5);
    expect(color.array[4]).toBeCloseTo(1, 5);
    expect(color.array[8]).toBeCloseTo(1, 5);
    expect(geometry.getAttribute('normal').count).toBe(3);
  });

  it('rejects a truncated buffer', () => {
    const { manifest, buffer } = writeSynthetic([
      { x: 1, z: 1, y: 1, r: 255, g: 255, b: 255 },
      { x: 1, z: 1, y: 1, r: 255, g: 255, b: 255 },
      { x: 1, z: 1, y: 1, r: 255, g: 255, b: 255 },
    ]);
    expect(() => createMuseumGeometry(manifest, buffer.slice(0, 10))).toThrow(/expected/);
  });

  it('ships a consistent exported payload', () => {
    const root = path.resolve(__dirname, '../../..');
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'public/data/museum/manifest.json'), 'utf8'),
    ) as MuseumManifest;
    const bin = readFileSync(path.join(root, 'public/data/museum/exhibits.bin'));

    expect(manifest.version).toBe(1);
    expect(manifest.vertices).toBeGreaterThan(0);
    expect(manifest.vertices % 3).toBe(0);
    expect(manifest.triangles).toBe(manifest.vertices / 3);
    expect(bin.byteLength).toBe(manifest.byteLength);
    expect(bin.byteLength).toBe(manifest.vertices * 9);

    let expectedOffset = 0;
    for (const section of manifest.sections) {
      expect(section.offset).toBe(expectedOffset);
      const elementSize = section.type === 'int16' ? 2 : 1;
      expectedOffset += section.count * elementSize;
    }
    expect(expectedOffset).toBe(bin.byteLength);

    expect(manifest.exhibits.length).toBeGreaterThanOrEqual(20);
    expect(manifest.missing.length).toBeGreaterThan(0);
    let previousEnd = 0;
    for (const exhibit of manifest.exhibits) {
      expect(exhibit.start).toBe(previousEnd);
      expect(exhibit.count % 3).toBe(0);
      expect(exhibit.start + exhibit.count).toBeLessThanOrEqual(manifest.vertices);
      previousEnd = exhibit.start + exhibit.count;
    }
    expect(previousEnd).toBe(manifest.vertices);

    const geometry = createMuseumGeometry(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    const position = geometry.getAttribute('position');
    const box = geometry.boundingBox;
    expect(box).not.toBeNull();
    expect(position.count).toBe(manifest.vertices);
    expect(box!.max.x - box!.min.x).toBeGreaterThan(100); // rows span > 100 m
    expect(box!.max.y - box!.min.y).toBeGreaterThan(10); // aircraft height above ground
  });
});
