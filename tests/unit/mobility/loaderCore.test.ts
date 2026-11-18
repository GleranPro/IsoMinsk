/**
 * Чистые функции загрузчика: выбор chunks/routes по bbox, ключи кеша по релизу,
 * проверки manifest/chunk/route payload. Сеть и three.js не участвуют.
 */

import { describe, expect, it } from 'vitest';
import { MOBILITY_VERSION, type MobilityChunkIndex, type MobilityManifest, type MobilityRouteIndexEntry } from '../../../src/shared/mobility';
import {
  boundsDistanceToRect,
  expandLoadRect,
  mobilityChunkCacheKey,
  mobilityFilePath,
  mobilityReleaseKey,
  mobilityReleaseLabel,
  mobilityRouteCacheKey,
  sameMobilityRelease,
  selectChunksForRect,
  selectRoutesForRect,
  validateChunkPayload,
  validateManifest,
  validateRouteFile,
  worldRectToLoadRect,
  type MobilityLoadRect,
} from '../../../src/engine/mobility/loaderCore';

function chunk(key: string, x: number, y: number, bytes = 1000): MobilityChunkIndex {
  return {
    key,
    bounds: [x, y, x + 256, y + 256],
    file: `chunks/${key}.json`,
    edges: 1,
    stops: 1,
    signals: 0,
    bytes,
  };
}

function route(id: string, x: number, y: number, verified = true): MobilityRouteIndexEntry {
  return {
    id,
    mode: 'bus',
    ref: '1',
    headSign: 'test',
    direction: 0,
    file: `routes/${id}.json`,
    bounds: [x, y, x + 256, y + 256],
    lengthM: 1000,
    verified,
    stops: 3,
    trips: 2,
    calendars: [],
  };
}

function manifestFixture(overrides: Partial<MobilityManifest> = {}): MobilityManifest {
  return {
    version: MOBILITY_VERSION,
    generatedAt: '2026-11-16T00:00:00Z',
    epsg: 32635,
    originUtm: [500000, 5970000],
    chunkSize: 256,
    bounds: [0, 0, 512, 512],
    chunks: [chunk('0_0', 0, 0), chunk('1_0', 256, 0), chunk('0_1', 0, 256), chunk('1_1', 256, 256)],
    routes: [route('r:1', 0, 0)],
    signalNodes: [],
    calendars: [],
    release: { network: 'net-a', schedule: 'sched-a', bindings: 'bind-a' },
    scheduleStatus: 'ready',
    provenance: [],
    counts: { edges: 4, stops: 4, signalNodes: 0, variants: 1, trips: 2, verifiedVariants: 1 },
    ...overrides,
  };
}

describe('loaderCore: область загрузки', () => {
  it('converts camera world XZ to local metres (x east, y north)', () => {
    const rect = worldRectToLoadRect({ minX: -10, maxX: 10, minZ: -20, maxZ: 30 });
    expect(rect).toEqual({ minX: -10, maxX: 10, minY: -30, maxY: 20 });
  });

  it('expands a rectangle by the margin and clamps negative margins', () => {
    const rect: MobilityLoadRect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(expandLoadRect(rect, 50)).toEqual({ minX: -50, minY: -50, maxX: 150, maxY: 150 });
    expect(expandLoadRect(rect, -5)).toEqual(rect);
  });

  it('selects only chunks intersecting the camera area plus margin', () => {
    const chunks = [
      chunk('0_0', 0, 0),
      chunk('1_0', 256, 0),
      chunk('0_1', 0, 256),
      chunk('far', 2000, 2000),
    ];
    const rect: MobilityLoadRect = { minX: 10, minY: 10, maxX: 20, maxY: 20 };
    expect(selectChunksForRect(chunks, rect).map((entry) => entry.key)).toEqual(['0_0']);
    // Запас 256 м добавляет соседей, но не дальний chunk — весь город не грузим.
    expect(selectChunksForRect(chunks, rect, { marginM: 256 }).map((entry) => entry.key)).toEqual([
      '0_0',
      '0_1',
      '1_0',
    ]);
    expect(selectChunksForRect(chunks, rect, { marginM: 256 }).some((entry) => entry.key === 'far')).toBe(false);
  });

  it('sorts nearest first and applies count/byte limits deterministically', () => {
    const chunks = [
      chunk('a', 0, 0, 100),
      chunk('b', 100, 0, 100),
      chunk('c', 200, 0, 5000),
    ];
    const rect: MobilityLoadRect = { minX: 0, minY: 0, maxX: 300, maxY: 100 };
    expect(selectChunksForRect(chunks, rect, { maxChunks: 2 }).map((entry) => entry.key)).toEqual(['a', 'b']);
    // Дорогой chunk пропускается по байтам, но первый (ближайший) берётся всегда.
    expect(selectChunksForRect(chunks, rect, { maxBytes: 350 }).map((entry) => entry.key)).toEqual(['a', 'b']);
    expect(selectChunksForRect(chunks, rect, { maxBytes: 50 }).map((entry) => entry.key)).toEqual(['a']);
  });

  it('measures distance to bounds and ignores invalid rectangles', () => {
    expect(boundsDistanceToRect([10, 0, 20, 20], { minX: 30, minY: 0, maxX: 40, maxY: 10 })).toBe(10);
    expect(boundsDistanceToRect([0, 0, 20, 20], { minX: 5, minY: 5, maxX: 6, maxY: 6 })).toBe(0);
    expect(selectChunksForRect([chunk('a', 0, 0)], { minX: 10, minY: 0, maxX: 0, maxY: 10 })).toEqual([]);
  });

  it('selects routes by bounds and skips unverified variants by default', () => {
    const routes = [route('r:1', 0, 0), route('r:2', 1000, 0), route('r:bad', 0, 0, false)];
    const rect: MobilityLoadRect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(selectRoutesForRect(routes, rect).map((entry) => entry.id)).toEqual(['r:1']);
    expect(selectRoutesForRect(routes, rect, { verifiedOnly: false }).map((entry) => entry.id)).toEqual([
      'r:1',
      'r:bad',
    ]);
    expect(selectRoutesForRect(routes, rect, { maxRoutes: 1 })).toHaveLength(1);
  });
});

describe('loaderCore: релиз и ключи кеша', () => {
  it('builds a stable release key and changes it when any component changes', () => {
    const release = { network: 'n', schedule: 's', bindings: 'b' };
    expect(mobilityReleaseKey(release)).toBe('n|s|b');
    expect(mobilityReleaseKey({ ...release, schedule: 's2' })).not.toBe(mobilityReleaseKey(release));
    expect(sameMobilityRelease(release, { ...release })).toBe(true);
    expect(sameMobilityRelease(release, { ...release, bindings: 'b2' })).toBe(false);
    expect(mobilityReleaseLabel(release, '2026-11-16')).toContain('2026-11-16');
  });

  it('includes the release in chunk/route cache keys', () => {
    expect(mobilityChunkCacheKey('rel-a', '0_0')).not.toBe(mobilityChunkCacheKey('rel-b', '0_0'));
    expect(mobilityChunkCacheKey('rel-a', '0_0')).toBe(mobilityChunkCacheKey('rel-a', '0_0'));
    expect(mobilityRouteCacheKey('rel-a', 'r:1')).toContain('r:1');
    expect(mobilityRouteCacheKey('rel-a', 'r:1')).not.toBe(mobilityRouteCacheKey('rel-b', 'r:1'));
  });

  it('joins data URLs without breaking absolute paths or a Vite base', () => {
    expect(mobilityFilePath('/base/data/mobility/', 'chunks/0_0.json')).toBe(
      '/base/data/mobility/chunks/0_0.json',
    );
    expect(mobilityFilePath('/data/mobility', '/absolute.json')).toBe('/absolute.json');
    expect(mobilityFilePath('/data/mobility', 'https://example.test/a.json')).toBe(
      'https://example.test/a.json',
    );
  });
});

describe('loaderCore: проверки payload', () => {
  it('accepts a valid manifest and normalises invalid records as non-fatal', () => {
    const valid = validateManifest(manifestFixture());
    expect(valid).toMatchObject({ ok: true, fatal: false });
    expect(valid.manifest?.chunks).toHaveLength(4);

    const raw = manifestFixture() as unknown as Record<string, unknown>;
    (raw.chunks as unknown[]).push({ key: '', file: '' });
    const withBroken = validateManifest(raw);
    expect(withBroken.ok).toBe(true);
    expect(withBroken.fatal).toBe(false);
    expect(withBroken.manifest?.chunks).toHaveLength(4);
    expect(withBroken.issues.join(' ')).toContain('chunks');

    const duplicate = manifestFixture() as unknown as Record<string, unknown>;
    (duplicate.chunks as unknown[]).push(chunk('0_0', 0, 0));
    const withDuplicate = validateManifest(duplicate);
    expect(withDuplicate.ok).toBe(true);
    expect(withDuplicate.manifest?.chunks).toHaveLength(4);
    expect(withDuplicate.issues.join(' ')).toContain('дубли');

    // Старые снимки без scheduleStatus не ломают загрузку: состояние absent.
    const noStatus = manifestFixture() as unknown as Record<string, unknown>;
    delete noStatus.scheduleStatus;
    const withoutStatus = validateManifest(noStatus);
    expect(withoutStatus.ok).toBe(true);
    expect(withoutStatus.manifest?.scheduleStatus).toBe('absent');
    expect(withoutStatus.issues.join(' ')).toContain('scheduleStatus');
  });

  it('rejects an incompatible version, a missing release or invalid bounds', () => {
    expect(validateManifest({ ...manifestFixture(), version: MOBILITY_VERSION + 1 })).toMatchObject({
      ok: false,
      fatal: true,
      manifest: null,
    });
    const noRelease = manifestFixture() as unknown as Record<string, unknown>;
    delete noRelease.release;
    expect(validateManifest(noRelease).fatal).toBe(true);
    expect(validateManifest({ ...manifestFixture(), bounds: [0, 0] }).fatal).toBe(true);
    expect(validateManifest({ ...manifestFixture(), chunkSize: 0 }).fatal).toBe(true);
    expect(validateManifest(null).fatal).toBe(true);
  });

  it('validates a chunk against its manifest index', () => {
    const entry = chunk('0_0', 0, 0);
    const payload = {
      version: MOBILITY_VERSION,
      key: '0_0',
      bounds: [0, 0, 256, 256],
      edges: [],
      stops: [],
      signals: [],
    };
    const valid = validateChunkPayload(payload, entry);
    expect(valid).toMatchObject({ ok: true, fatal: false });
    expect(valid.chunk?.key).toBe('0_0');

    expect(validateChunkPayload({ ...payload, key: '1_0' }, entry).fatal).toBe(true);
    expect(validateChunkPayload({ ...payload, version: 2 }, entry).fatal).toBe(true);
    expect(validateChunkPayload({ ...payload, bounds: [0, 0, 1, 1] }, entry).fatal).toBe(true);

    const missingArrays = validateChunkPayload(
      { version: MOBILITY_VERSION, key: '0_0', bounds: [0, 0, 256, 256] },
      { ...entry, edges: 2, stops: 1, signals: 0 },
    );
    expect(missingArrays.ok).toBe(true);
    expect(missingArrays.issues.join(' ')).toContain('edges');
    expect(missingArrays.issues.join(' ')).toContain('stops');
  });

  it('validates a route file identity and notes unverified variants', () => {
    const file = {
      version: MOBILITY_VERSION,
      variant: {
        id: 'r:1',
        mode: 'bus',
        ref: '1',
        headSign: 'test',
        direction: 0,
        edges: [],
        stops: [],
        lengthM: 0,
        sourceRelationId: 1,
        verified: false,
        bounds: [0, 0, 1, 1],
      },
      trips: [],
    };
    const result = validateRouteFile(file, { id: 'r:1', stops: 0, trips: 0, mode: 'bus' });
    expect(result).toMatchObject({ ok: true, fatal: false });
    expect(result.issues.join(' ')).toContain('аудит');
    expect(validateRouteFile(file, { id: 'r:2' }).fatal).toBe(true);
    expect(validateRouteFile({ ...file, version: 99 }, { id: 'r:1' }).fatal).toBe(true);
  });
});
