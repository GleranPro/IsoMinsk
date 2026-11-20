/**
 * Low-poly landmark models: catalog contract, baked payload and the hiding of
 * the OSM buildings a model replaces.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBuildingsMesh } from '../../../src/city/buildings/buildingsMesh';
import {
  createLandmarkGeometry,
  LandmarkLayer,
  type LandmarkManifest,
} from '../../../src/engine/landmarks/landmarkLayer';
import { LANDMARK_HIDDEN_BUILDING_IDS, PLACED_LANDMARKS } from '../../../src/shared/landmarks';
import { squarePrismBuilding } from '../../fixtures/buildings';

const PAYLOAD = resolve(__dirname, '../../../public/data/landmarks');

function loadPayload(): { manifest: LandmarkManifest; buffer: ArrayBuffer } {
  const manifest = JSON.parse(readFileSync(resolve(PAYLOAD, 'manifest.json'), 'utf8')) as LandmarkManifest;
  const bytes = readFileSync(resolve(PAYLOAD, 'landmarks.bin'));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return { manifest, buffer };
}

describe('landmark catalog', () => {
  it('hides every part of a model that stands for several OSM objects', () => {
    // Holy Spirit cathedral model = cathedral + Bernardine monastery + gatehouse.
    for (const id of ['w538208752', 'w25387248', 'w1019411792']) {
      expect(LANDMARK_HIDDEN_BUILDING_IDS.has(id)).toBe(true);
    }
    // The railway station model includes the 54 m tower next to the hall.
    expect(LANDMARK_HIDDEN_BUILDING_IDS.has('w358224860')).toBe(true);
    expect(LANDMARK_HIDDEN_BUILDING_IDS.has('w135566700')).toBe(true);
  });

  it('hides the Kirova 25 house together with the art museum that includes it', () => {
    // The art-museum model is the museum block plus the neighbouring house on Kirova street.
    expect(LANDMARK_HIDDEN_BUILDING_IDS.has('w25327627')).toBe(true);
    expect(LANDMARK_HIDDEN_BUILDING_IDS.has('w25327631')).toBe(true);
    // Karl Marx 24 is a separate model with its own building.
    expect(LANDMARK_HIDDEN_BUILDING_IDS.has('w25327593')).toBe(true);
  });

  it('replaces the Gorky Park gate relation, not the lamp pylons beside it', () => {
    expect(LANDMARK_HIDDEN_BUILDING_IDS.has('r11788611')).toBe(true);
    expect(LANDMARK_HIDDEN_BUILDING_IDS.has('w1144853023')).toBe(false);
    expect(LANDMARK_HIDDEN_BUILDING_IDS.has('w1144927252')).toBe(false);
  });

  it('gives every way-based landmark at least its own building to hide', () => {
    for (const entry of PLACED_LANDMARKS) {
      if (entry.osm.startsWith('w')) {
        expect(entry.hide, entry.slug).toContain(entry.osm);
      }
    }
  });

  it('keeps hide lists disjoint between landmarks', () => {
    const owner = new Map<string, string>();
    for (const entry of PLACED_LANDMARKS) {
      for (const id of entry.hide ?? []) {
        expect(owner.get(id), `${id} claimed by ${owner.get(id)} and ${entry.slug}`).toBeUndefined();
        owner.set(id, entry.slug);
      }
    }
  });
});

describe('baked landmark payload', () => {
  const { manifest, buffer } = loadPayload();

  it('contains exactly the placed landmarks, as contiguous vertex ranges', () => {
    expect(manifest.landmarks.map((m) => m.slug).sort()).toEqual(PLACED_LANDMARKS.map((e) => e.slug).sort());
    let cursor = 0;
    for (const meta of manifest.landmarks) {
      expect(meta.start).toBe(cursor);
      expect(meta.count % 3).toBe(0);
      cursor += meta.count;
    }
    expect(cursor).toBe(manifest.vertices);
    expect(buffer.byteLength).toBeGreaterThanOrEqual(manifest.vertices * 9);
  });

  it('decodes every landmark to a finite, ground-based model of plausible size', () => {
    for (const meta of manifest.landmarks) {
      const geometry = createLandmarkGeometry(manifest, meta, buffer);
      const box = geometry.boundingBox!;
      expect(Number.isFinite(box.min.x + box.max.x + box.min.y + box.max.y), meta.slug).toBe(true);
      expect(box.min.y, meta.slug).toBeGreaterThanOrEqual(-0.2);
      expect(box.min.y, meta.slug).toBeLessThanOrEqual(0.5);
      expect(box.max.y, meta.slug).toBeGreaterThan(4);
      expect(box.max.y, meta.slug).toBeLessThan(90);
      const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
      expect(span, meta.slug).toBeGreaterThan(5);
      expect(span, meta.slug).toBeLessThan(340); // Minsk-Arena incl. its stands
      geometry.dispose();
    }
  });

  it('rejects a range outside the buffer', () => {
    expect(() => createLandmarkGeometry(manifest, { start: manifest.vertices - 3, count: 6 }, buffer)).toThrow();
  });
});

describe('mesh builder', () => {
  it('emits no geometry for a building that a landmark model replaces', () => {
    const hiddenId = [...LANDMARK_HIDDEN_BUILDING_IDS][0];
    const options = { facadeDetail: false, hiddenBuildingIds: LANDMARK_HIDDEN_BUILDING_IDS };
    const visible = buildBuildingsMesh([squarePrismBuilding()], options);
    const hidden = buildBuildingsMesh([squarePrismBuilding({ id: hiddenId })], options);
    expect(visible.triangleCount).toBeGreaterThan(0);
    expect(hidden.triangleCount).toBe(0);
    expect(hidden.buildingIds).toEqual([hiddenId]);
  });
});

describe('landmark interaction surface', () => {
  const { manifest, buffer } = loadPayload();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes one pickable mesh per landmark, and a centred card preview', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body: BodyInit = url.endsWith('/manifest.json') ? JSON.stringify(manifest) : buffer;
      return new Response(body, { status: 200 });
    });

    const layer = new LandmarkLayer();
    await layer.load();
    expect(layer.state).toBe('ready');
    expect(layer.getPickables()).toHaveLength(manifest.landmarks.length);
    for (const mesh of layer.getPickables()) {
      expect(mesh.userData.slug, mesh.name).toBeTypeOf('string');
      expect(layer.getMeta(mesh.userData.slug as string)).not.toBeNull();
    }

    const preview = layer.getPreview('red-church');
    expect(preview).not.toBeNull();
    const position = preview!.positions;
    // The card viewer expects the model centred on x/z and resting on y=0.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < position.length; i += 3) {
      minX = Math.min(minX, position[i]);
      maxX = Math.max(maxX, position[i]);
      minY = Math.min(minY, position[i + 1]);
      minZ = Math.min(minZ, position[i + 2]);
      maxZ = Math.max(maxZ, position[i + 2]);
    }
    expect(minY).toBeCloseTo(0, 5);
    expect(maxX + minX).toBeCloseTo(0, 4);
    expect(maxZ + minZ).toBeCloseTo(0, 4);

    layer.setSelected('red-church');
    expect(layer.selectedSlug).toBe('red-church');
    expect(layer.root.getObjectByName('landmark-highlight-red-church')).toBeDefined();
    layer.update(16);
    layer.setSelected(null);
    expect(layer.selectedSlug).toBeNull();
    expect(layer.root.getObjectByName('landmark-highlight-red-church')).toBeUndefined();
    layer.dispose();
  });
});
