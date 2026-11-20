/**
 * War Museum Li-2 payload contract.
 *
 * The Li-2 beside OSM way w127103385 (the museum building) is exported by
 * `scripts/war-museum/export_web.py` in the same binary format as the Lipki
 * museum, so the engine reuses `MuseumLayer` and `createMuseumGeometry`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMuseumGeometry, type MuseumManifest } from '../../../src/engine/museum/museumLayer';

const ROOT = path.resolve(__dirname, '../../..');

function readPayload() {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, 'public/data/warmuseum/manifest.json'), 'utf8'),
  ) as MuseumManifest;
  const bin = readFileSync(path.join(ROOT, 'public/data/warmuseum/exhibits.bin'));
  return { manifest, bin };
}

describe('War Museum Li-2 payload', () => {
  it('ships the round pad and the aircraft with the annotated heading', () => {
    const { manifest, bin } = readPayload();
    expect(manifest.version).toBe(1);
    expect(manifest.origin[0]).toBeCloseTo(-1584.04, 2);
    expect(manifest.origin[1]).toBeCloseTo(1646.18, 2);
    expect(manifest.exhibits.map((exhibit) => exhibit.slug)).toEqual(['li-2', 'pad']);

    const li2 = manifest.exhibits[0];
    expect(li2.ref).toContain('Ли-2');
    expect(li2.heading).toBeCloseTo(-28.7, 1);
    expect(li2.x).toBeCloseTo(-1584.04, 2);
    expect(li2.y).toBeCloseTo(1646.18, 2);
    expect(li2.triangles).toBeGreaterThan(20000);

    const pad = manifest.exhibits[1];
    expect(pad.triangles).toBe(48 * 3);
    expect(pad.start).toBe(li2.start + li2.count);

    expect(bin.byteLength).toBe(manifest.byteLength);
    expect(bin.byteLength).toBe(manifest.vertices * 9);
    expect(manifest.triangles).toBe(li2.triangles + pad.triangles);
    let previousEnd = 0;
    for (const exhibit of manifest.exhibits) {
      expect(exhibit.start).toBe(previousEnd);
      expect(exhibit.count % 3).toBe(0);
      previousEnd += exhibit.count;
    }
    expect(previousEnd).toBe(manifest.vertices);
  });

  it('decodes into world space on the round pad', () => {
    const { manifest, bin } = readPayload();
    const geometry = createMuseumGeometry(
      manifest,
      bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
    );
    const position = geometry.getAttribute('position');
    expect(position.count).toBe(manifest.vertices);
    const box = geometry.boundingBox;
    expect(box).not.toBeNull();
    // 28.8 m wingspan + pad radius; the rotated Li-2 spans ~27 m.
    expect(box!.max.x - box!.min.x).toBeGreaterThan(24);
    expect(box!.max.z - box!.min.z).toBeGreaterThan(24);
    expect(box!.max.y).toBeGreaterThan(3);
    expect(box!.min.y).toBeCloseTo(0, 1);
  });
});
