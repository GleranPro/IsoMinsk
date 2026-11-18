/**
 * Загрузчик мобильности с подменённым fetch: загрузка по области камеры,
 * лимиты, отмена запросов, инвалидация по релизу, маршруты по требованию и
 * несовместимая версия без падения карты.
 */

import { describe, expect, it } from 'vitest';
import {
  MOBILITY_VERSION,
  type MobilityChunkIndex,
  type MobilityManifest,
  type MobilityRouteIndexEntry,
} from '../../../src/shared/mobility';
import {
  MobilityLoader,
  type MobilityFetchImpl,
  type MobilityFetchResponse,
} from '../../../src/engine/mobility/loader';

const BASE = '/data/mobility';
const MANIFEST_URL = `${BASE}/manifest.json`;

function ok(body: unknown): MobilityFetchResponse {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text };
}

function missing(): MobilityFetchResponse {
  return { ok: false, status: 404, text: async () => '' };
}

function chunkEntry(key: string, x: number, y: number): MobilityChunkIndex {
  return {
    key,
    bounds: [x, y, x + 256, y + 256],
    file: `chunks/${key}.json`,
    edges: 0,
    stops: 0,
    signals: 0,
    bytes: 120,
  };
}

function routeEntry(id: string, verified = true): MobilityRouteIndexEntry {
  return {
    id,
    mode: 'bus',
    ref: '1',
    headSign: 'Вокзал',
    direction: 0,
    file: `routes/${id.replace(':', '_')}.json`,
    bounds: [0, 0, 256, 256],
    lengthM: 1200,
    verified,
    stops: 2,
    trips: 1,
    calendars: ['cal:c1'],
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
    chunks: [
      chunkEntry('0_0', 0, 0),
      chunkEntry('1_0', 256, 0),
      chunkEntry('0_1', 0, 256),
      chunkEntry('1_1', 256, 256),
    ],
    routes: [routeEntry('r:1'), routeEntry('r:bad', false)],
    signalNodes: [],
    calendars: [],
    release: { network: 'net-a', schedule: 'sched-a', bindings: 'bind-a' },
    scheduleStatus: 'ready',
    provenance: [],
    counts: { edges: 0, stops: 0, signalNodes: 0, variants: 2, trips: 2, verifiedVariants: 1 },
    ...overrides,
  };
}

function chunkPayload(key: string, x: number, y: number): unknown {
  return {
    version: MOBILITY_VERSION,
    key,
    bounds: [x, y, x + 256, y + 256],
    edges: [],
    stops: [],
    signals: [],
  };
}

function routePayload(id: string): unknown {
  return {
    version: MOBILITY_VERSION,
    variant: {
      id,
      mode: 'bus',
      ref: '1',
      headSign: 'Вокзал',
      direction: 0,
      edges: [],
      stops: [],
      lengthM: 1200,
      sourceRelationId: 1,
      verified: true,
      bounds: [0, 0, 256, 256],
    },
    trips: [],
  };
}

function chunkUrl(key: string): string {
  return `${BASE}/chunks/${key}.json`;
}

interface Server {
  fetchImpl: MobilityFetchImpl;
  requests: string[];
  signals: Map<string, AbortSignal | undefined>;
  bodies: Map<string, unknown>;
}

function createServer(manifest: MobilityManifest, withChunks = true): Server {
  const bodies = new Map<string, unknown>();
  bodies.set(MANIFEST_URL, manifest);
  if (withChunks) {
    for (const entry of manifest.chunks) {
      const [x, y] = entry.bounds;
      bodies.set(chunkUrl(entry.key), chunkPayload(entry.key, x, y));
    }
    for (const entry of manifest.routes) bodies.set(`${BASE}/${entry.file}`, routePayload(entry.id));
  }
  const requests: string[] = [];
  const signals = new Map<string, AbortSignal | undefined>();
  const fetchImpl: MobilityFetchImpl = (url, init) => {
    requests.push(url);
    signals.set(url, init?.signal);
    if (!bodies.has(url)) return Promise.resolve(missing());
    return Promise.resolve(ok(bodies.get(url)));
  };
  return { fetchImpl, requests, signals, bodies };
}

const SMALL_RECT = { minX: 10, minY: 10, maxX: 20, maxY: 20 };
const FULL_RECT = { minX: 0, minY: 0, maxX: 512, maxY: 512 };

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MobilityLoader', () => {
  it('loads the manifest and only the chunks around the camera', async () => {
    const manifest = manifestFixture();
    const server = createServer(manifest);
    const loader = new MobilityLoader({ baseUrl: BASE, fetchImpl: server.fetchImpl, chunkMarginM: 0 });
    await loader.start();
    expect(loader.state).toBe('loading');
    expect(loader.manifest?.release.schedule).toBe('sched-a');

    loader.update(SMALL_RECT);
    await loader.whenIdle();
    expect(loader.loadedChunkCount).toBe(1);
    expect(loader.state).toBe('ready');
    expect(server.requests).toContain(chunkUrl('0_0'));
    for (const key of ['1_0', '0_1', '1_1']) {
      expect(server.requests, `весь город не загружается: ${key}`).not.toContain(chunkUrl(key));
    }
    expect(loader.loadedBytes).toBeGreaterThan(0);
    expect(loader.getStats()).toMatchObject({ loadedChunks: 1, desiredChunks: 1, failedChunks: 0 });
    loader.dispose();
  });

  it('respects the chunk count limit and never loads the whole city', async () => {
    const server = createServer(manifestFixture());
    const loader = new MobilityLoader({
      baseUrl: BASE,
      fetchImpl: server.fetchImpl,
      chunkMarginM: 512,
      maxChunks: 2,
    });
    await loader.start();
    loader.update(FULL_RECT);
    await loader.whenIdle();
    expect(loader.loadedChunkCount).toBe(2);
    expect(server.requests.filter((url) => url.includes('/chunks/'))).toHaveLength(2);
    expect(loader.getStats().desiredChunks).toBe(2);
    loader.dispose();
  });

  it('evicts an old chunk when the byte budget is full and the camera moves', async () => {
    const server = createServer(manifestFixture());
    const loader = new MobilityLoader({
      baseUrl: BASE,
      fetchImpl: server.fetchImpl,
      chunkMarginM: 0,
      // Ровно один chunk: после переезда камеры старый должен уступить место,
      // иначе новые чанки области не загрузятся, а маршруты останутся на хордах.
      maxChunkBytes: 120,
    });
    await loader.start();
    loader.update(SMALL_RECT);
    await loader.whenIdle();
    expect(loader.debugState().loaded).toEqual(['0_0']);

    const moved = { minX: 266, minY: 266, maxX: 276, maxY: 276 };
    loader.update(moved);
    await loader.whenIdle();
    expect(loader.debugState().loaded).toEqual(['1_1']);
    expect(server.requests).toContain(chunkUrl('1_1'));
    loader.dispose();
  });

  it('reports an incompatible version as error and keeps the map usable', async () => {
    const server = createServer(manifestFixture({ version: MOBILITY_VERSION + 1 }));
    const loader = new MobilityLoader({ baseUrl: BASE, fetchImpl: server.fetchImpl });
    await expect(loader.start()).resolves.toBeUndefined();
    expect(loader.state).toBe('error');
    expect(loader.error).toContain('версия');
    loader.update(SMALL_RECT);
    await loader.whenIdle();
    expect(server.requests.filter((url) => url.includes('/chunks/'))).toHaveLength(0);
    loader.dispose();
  });

  it('marks a missing payload as unavailable without throwing', async () => {
    const server = createServer(manifestFixture());
    server.bodies.delete(MANIFEST_URL);
    const loader = new MobilityLoader({ baseUrl: BASE, fetchImpl: server.fetchImpl, retryDelayMs: 0 });
    await loader.start();
    expect(loader.state).toBe('unavailable');
    expect(loader.error).toBeNull();
    expect(loader.notesList.join(' ')).toContain('404');
    loader.dispose();
  });

  it('tracks a partial state when one chunk fails to load', async () => {
    const manifest = manifestFixture();
    const server = createServer(manifest);
    server.bodies.delete(chunkUrl('0_0'));
    const loader = new MobilityLoader({ baseUrl: BASE, fetchImpl: server.fetchImpl, chunkMarginM: 0 });
    await loader.start();
    loader.update(SMALL_RECT);
    await loader.whenIdle();
    expect(loader.state).toBe('partial');
    expect(loader.getStats().failedChunks).toBe(1);
    expect(loader.notesList.join(' ')).toContain('0_0');
    loader.dispose();
  });

  it('aborts in-flight requests on dispose', async () => {
    const manifest = manifestFixture();
    let chunkSignal: AbortSignal | undefined;
    const fetchImpl: MobilityFetchImpl = (url, init) => {
      if (url === MANIFEST_URL) return Promise.resolve(ok(manifest));
      chunkSignal = init?.signal;
      return new Promise<MobilityFetchResponse>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const loader = new MobilityLoader({ baseUrl: BASE, fetchImpl, chunkMarginM: 0 });
    await loader.start();
    loader.update(SMALL_RECT);
    await tick();
    expect(chunkSignal).toBeDefined();
    expect(chunkSignal?.aborted).toBe(false);
    loader.dispose();
    expect(chunkSignal?.aborted).toBe(true);
    await tick();
    expect(loader.state).toBe('idle');
  });

  it('invalidates the cache when the release changes', async () => {
    const manifest = manifestFixture();
    const server = createServer(manifest);
    const loader = new MobilityLoader({ baseUrl: BASE, fetchImpl: server.fetchImpl, chunkMarginM: 0 });
    await loader.start();
    loader.update(SMALL_RECT);
    await loader.whenIdle();
    expect(loader.loadedChunkCount).toBe(1);
    const oldRevision = loader.revision;

    const nextRelease = { network: 'net-b', schedule: 'sched-b', bindings: 'bind-b' };
    server.bodies.set(MANIFEST_URL, manifestFixture({ release: nextRelease }));
    await loader.reload();
    expect(loader.loadedChunkCount).toBe(0);
    expect(loader.revision).not.toBe(oldRevision);
    expect(loader.getStats().releaseKey).toContain('net-b');
    expect(loader.notesList.join(' ')).toContain('релиз');

    loader.update(SMALL_RECT);
    await loader.whenIdle();
    expect(loader.loadedChunkCount).toBe(1);
    loader.dispose();
  });

  it('aborts in-flight route fetches on dispose', async () => {
    const manifest = manifestFixture();
    let routeSignal: AbortSignal | undefined;
    const fetchImpl: MobilityFetchImpl = (url, init) => {
      if (url === MANIFEST_URL) return Promise.resolve(ok(manifest));
      routeSignal = init?.signal;
      return new Promise<MobilityFetchResponse>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const loader = new MobilityLoader({ baseUrl: BASE, fetchImpl });
    await loader.start();
    const routeTask = loader.ensureRoutes(['r:1']);
    await tick();
    expect(routeSignal).toBeDefined();
    loader.dispose();
    expect(routeSignal?.aborted).toBe(true);
    await routeTask;
    expect(loader.hasVariant('r:1')).toBe(false);
  });

  it('loads route variants on demand and skips unverified ones', async () => {
    const server = createServer(manifestFixture());
    const loader = new MobilityLoader({ baseUrl: BASE, fetchImpl: server.fetchImpl, chunkMarginM: 0 });
    await loader.start();
    await loader.ensureRoutes(['r:1']);
    expect(loader.hasVariant('r:1')).toBe(true);
    expect(loader.getVariant('r:1')?.variant.id).toBe('r:1');
    const routeRequests = server.requests.filter((url) => url.includes('/routes/')).length;
    expect(routeRequests).toBe(1);
    // Повторный запрос берётся из кеша, без нового fetch.
    await loader.ensureRoutes(['r:1']);
    expect(server.requests.filter((url) => url.includes('/routes/')).length).toBe(1);

    await loader.ensureRoutes(['r:bad']);
    expect(server.requests.filter((url) => url.includes('/routes/')).length).toBe(1);
    expect(loader.notesList.join(' ')).toContain('аудит');
    expect(loader.getStats().skippedRoutes).toBe(1);
    loader.dispose();
  });

  it('selects routes for the camera area by their bounds', async () => {
    const server = createServer(manifestFixture());
    const loader = new MobilityLoader({ baseUrl: BASE, fetchImpl: server.fetchImpl, routeMarginM: 0 });
    await loader.start();
    await loader.ensureRoutesForRect({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(loader.hasVariant('r:1')).toBe(true);
    expect(loader.hasVariant('r:bad')).toBe(false);
    loader.dispose();
  });

  it('does nothing after dispose', async () => {
    const server = createServer(manifestFixture());
    const loader = new MobilityLoader({ baseUrl: BASE, fetchImpl: server.fetchImpl });
    await loader.start();
    loader.dispose();
    const before = server.requests.length;
    loader.update(SMALL_RECT);
    await loader.ensureRoutes(['r:1']);
    expect(server.requests.length).toBe(before);
    expect(loader.state).toBe('idle');
  });
});
