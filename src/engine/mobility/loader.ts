/**
 * Isometric Minsk — загрузчик данных мобильности по области камеры.
 *
 * Загружает только manifest, chunks вокруг камеры (bbox + запас) и файлы
 * вариантов маршрутов по требованию. Никакой загрузки всего города: выбор
 * chunks ограничен прямоугольником камеры, запасом и лимитами по числу/байтам,
 * а маршруты запрашиваются только те, что нужны симуляции.
 *
 * Контракт (см. `src/shared/mobility.ts`):
 *   manifest.json  — версия, границы, индекс chunks/routes/signalNodes, release;
 *   chunks/*.json  — геометрия и светофоры в локальных метрах;
 *   routes/*.json  — вариант маршрута и его рейсы.
 *
 * Идентичность релиза `(network, schedule, bindings)` — часть каждого ключа
 * кеша. При смене релиза кеш полностью инвалидируется: смешивать данные разных
 * релизов нельзя. Ошибки не бросаются наружу: карта продолжает работать, а
 * состояние становится `error`/`partial`/`unavailable` (см. `MobilityDataState`).
 *
 * Сеть: каждый запрос получает свой `AbortController`; `dispose()` и смена
 * области отменяют ненужные fetches. Uni-тесты подменяют `fetch` через
 * `options.fetchImpl`, поэтому сам загрузчик не зависит от глобального fetch.
 */

import type {
  MobilityChunk,
  MobilityChunkIndex,
  MobilityDataState,
  MobilityManifest,
  MobilityRouteFile,
  MobilityRouteIndexEntry,
  MobilitySignalNode,
} from '../../shared/mobility';
import { MOBILITY_VERSION } from '../../shared/mobility';
import { publicAssetUrl } from '../../shared/assets';
import {
  isValidLoadRect,
  mobilityFilePath,
  mobilityReleaseKey,
  mobilityRouteCacheKey,
  selectChunksForRect,
  selectRoutesForRect,
  validateChunkPayload,
  validateManifest,
  validateRouteFile,
  type MobilityLoadRect,
} from './loaderCore';

/** Ответ, который загрузчику нужен от fetch (совместим с `Response`). */
export interface MobilityFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Подменяемая реализация fetch (тесты/браузер). */
export type MobilityFetchImpl = (
  url: string,
  init?: { signal?: AbortSignal; cache?: RequestCache },
) => Promise<MobilityFetchResponse>;

/**
 * Базовый URL публичных данных мобильности.
 *
 * Разрешается относительно базы развёртывания, как и тайлы: Pages отдаёт
 * приложение из подкаталога проекта, поэтому абсолютный `/data/mobility`
 * указывал бы в корень домена и давал 404.
 */
export const MOBILITY_DATA_BASE_URL = publicAssetUrl('data/mobility');

export interface MobilityLoaderOptions {
  /** Каталог данных; по умолчанию `/data/mobility`. */
  baseUrl?: string;
  /** Полный URL manifest (перекрывает baseUrl). */
  manifestUrl?: string;
  /** Реализация fetch; по умолчанию глобальный fetch. */
  fetchImpl?: MobilityFetchImpl;
  /** Запас вокруг области камеры для chunks, метры (торможение/видимость). */
  chunkMarginM?: number;
  /** Запас для выбора вариантов маршрутов, метры. */
  routeMarginM?: number;
  /** Максимум одновременно загруженных chunks (кеш). */
  maxChunks?: number;
  /** Лимит загруженных байт chunks; 0 — без лимита. */
  maxChunkBytes?: number;
  /** Одновременных запросов chunks. */
  maxConcurrentChunks?: number;
  /** Максимум кешированных файлов вариантов. */
  maxVariantFiles?: number;
  /** Лимит байт файлов вариантов; 0 — без лимита. */
  maxRouteBytes?: number;
  /** Загружать/показывать только проверенные варианты. */
  verifiedRoutesOnly?: boolean;
  /** Пауза между повторами manifest, мс. */
  retryDelayMs?: number;
  /** Через сколько мс пробовать снова упавший chunk/вариант. */
  retryFailedAfterMs?: number;
  onStateChange?: (state: MobilityDataState) => void;
  /** Несовместимость версии/данных (карта остаётся рабочей). */
  onError?: (message: string) => void;
  /** Набор загруженных chunks изменился (слой перестраивает светофоры). */
  onChunksChanged?: () => void;
  /** Набор вариантов маршрутов изменился. */
  onRoutesChanged?: () => void;
}

/** Статистика для панели/QA; `loadedBytes` учитывает только chunks. */
export interface MobilityLoaderStats {
  state: MobilityDataState;
  releaseKey: string | null;
  loadedChunks: number;
  loadedBytes: number;
  inflightChunks: number;
  failedChunks: number;
  desiredChunks: number;
  loadedRoutes: number;
  routeBytes: number;
  inflightRoutes: number;
  failedRoutes: number;
  skippedRoutes: number;
  requests: number;
  notes: readonly string[];
}

interface LoadedChunk {
  index: MobilityChunkIndex;
  chunk: MobilityChunk;
  bytes: number;
  lastUsed: number;
}

interface LoadedRoute {
  index: MobilityRouteIndexEntry;
  file: MobilityRouteFile;
  bytes: number;
  lastUsed: number;
}

interface InflightChunk {
  index: MobilityChunkIndex;
  controller: AbortController;
}

class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} для ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return (
    candidate.name === 'AbortError' ||
    (typeof candidate.message === 'string' && /abort|отмен/i.test(candidate.message))
  );
}

function nowMs(): number {
  return Date.now();
}

function defaultFetchImpl(url: string, init?: { signal?: AbortSignal; cache?: RequestCache }): Promise<MobilityFetchResponse> {
  return fetch(url, init);
}

function delay(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Загрузчик мобильности. Жизненный цикл:
 *   1. `start()` — manifest (не бросает исключений);
 *   2. `update(rect)` — вызывается по камере, планирует chunks с запасом;
 *   3. `ensureRoutes(ids)` / `ensureRoutesForRect(rect)` — по требованию;
 *   4. `getChunks()`, `getVariant()`, `getSignalNodes()`, `getStats()`;
 *   5. `dispose()` — отмена fetch и очистка кешей.
 *
 * `update` дешёвый: пересчёт выбора выполняется только при заметном смещении
 * области (четверть chunkSize) или изменении размера. Загрузка идёт
 * асинхронно, число одновременных запросов ограничено.
 */
export class MobilityLoader {
  readonly baseUrl: string;
  readonly manifestUrl: string;

  private readonly options: MobilityLoaderOptions;
  private readonly fetchImpl: MobilityFetchImpl;
  private readonly chunkMarginM: number;
  private readonly routeMarginM: number;
  private readonly maxChunks: number;
  private readonly maxChunkBytes: number;
  private readonly maxConcurrentChunks: number;
  private readonly maxVariantFiles: number;
  private readonly maxRouteBytes: number;
  private readonly verifiedRoutesOnly: boolean;
  private readonly retryDelayMs: number;
  private readonly retryFailedAfterMs: number;

  manifest: MobilityManifest | null = null;
  private releaseKey: string | null = null;
  private currentState: MobilityDataState = 'idle';
  private fatalError: string | null = null;
  private unavailable = false;
  private started = false;
  private hasUpdated = false;
  private disposed = false;

  private readonly chunks = new Map<string, LoadedChunk>();
  private readonly inflightChunks = new Map<string, InflightChunk>();
  private readonly failedChunks = new Map<string, number>();
  private readonly routes = new Map<string, LoadedRoute>();
  private readonly inflightRoutes = new Map<string, Promise<void>>();
  private readonly inflightRouteControllers = new Map<string, AbortController>();
  private readonly failedRoutes = new Map<string, number>();
  /** Варианты, которые осознанно не загружены (нет в индексе / не прошли аудит). */
  private readonly skippedRoutes = new Map<string, number>();
  private requestedRouteIds = new Set<string>();

  private desiredChunks: MobilityChunkIndex[] = [];
  private desiredKeys = new Set<string>();
  private lastRect: MobilityLoadRect | null = null;
  private loadedBytesCount = 0;
  private routeBytesCount = 0;
  private requestCount = 0;
  private manifestController: AbortController | null = null;
  private manifestPromise: Promise<void> | null = null;
  private chunkRevision = 0;
  private signalNodesCache: MobilitySignalNode[] | null = null;
  private readonly notes: string[] = [];
  private readonly idleWaiters: Array<() => void> = [];

  constructor(options: MobilityLoaderOptions = {}) {
    this.options = options;
    this.baseUrl = (options.baseUrl ?? MOBILITY_DATA_BASE_URL).replace(/\/+$/, '');
    this.manifestUrl = options.manifestUrl ?? `${this.baseUrl}/manifest.json`;
    this.fetchImpl = options.fetchImpl ?? defaultFetchImpl;
    this.chunkMarginM = Math.max(0, options.chunkMarginM ?? 400);
    this.routeMarginM = Math.max(0, options.routeMarginM ?? 200);
    this.maxChunks = Math.max(1, Math.floor(options.maxChunks ?? 32));
    this.maxChunkBytes = Math.max(0, options.maxChunkBytes ?? 8 * 1024 * 1024);
    this.maxConcurrentChunks = Math.max(1, Math.floor(options.maxConcurrentChunks ?? 2));
    this.maxVariantFiles = Math.max(1, Math.floor(options.maxVariantFiles ?? 8));
    this.maxRouteBytes = Math.max(0, options.maxRouteBytes ?? 4 * 1024 * 1024);
    this.verifiedRoutesOnly = options.verifiedRoutesOnly ?? true;
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 400);
    this.retryFailedAfterMs = Math.max(1000, options.retryFailedAfterMs ?? 30_000);
  }

  // -------------------------------------------------------------------------
  // состояние и счётчики
  // -------------------------------------------------------------------------

  get state(): MobilityDataState {
    return this.currentState;
  }

  /** Причина `error`, если загрузка несовместима; иначе null. */
  get error(): string | null {
    return this.fatalError;
  }

  /** Некритичные проблемы: отброшенные записи, упавшие chunks, пропуски. */
  get notesList(): readonly string[] {
    return this.notes;
  }

  /** Счётчик изменений набора chunks: по нему слой перестраивает светофоры. */
  get revision(): number {
    return this.chunkRevision;
  }

  /** Псевдоним `revision` для читаемости в вызывающем коде. */
  get signalRevision(): number {
    return this.chunkRevision;
  }

  get loadedBytes(): number {
    return this.loadedBytesCount;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  /** QA: last rect and the chunk window the loader actually holds. */
  debugState(): {
    lastRect: MobilityLoadRect | null;
    desired: string[];
    loaded: string[];
    inflight: string[];
  } {
    return {
      lastRect: this.lastRect ? { ...this.lastRect } : null,
      desired: [...this.desiredKeys],
      loaded: [...this.chunks.keys()],
      inflight: [...this.inflightChunks.keys()],
    };
  }

  getStats(): MobilityLoaderStats {
    return {
      state: this.currentState,
      releaseKey: this.releaseKey,
      loadedChunks: this.chunks.size,
      loadedBytes: this.loadedBytesCount,
      inflightChunks: this.inflightChunks.size,
      failedChunks: this.failedChunks.size,
      desiredChunks: this.desiredChunks.length,
      loadedRoutes: this.routes.size,
      routeBytes: this.routeBytesCount,
      inflightRoutes: this.inflightRoutes.size,
      failedRoutes: this.failedRoutes.size,
      skippedRoutes: this.skippedRoutes.size,
      requests: this.requestCount,
      notes: [...this.notes],
    };
  }

  // -------------------------------------------------------------------------
  // manifest
  // -------------------------------------------------------------------------

  /** Загружает manifest. Повторный вызов после ошибки разрешён. */
  async start(): Promise<void> {
    if (this.disposed) return;
    if (this.manifest) return;
    if (this.manifestPromise) return this.manifestPromise;
    this.started = true;
    this.manifestPromise = this.loadManifest();
    try {
      await this.manifestPromise;
    } finally {
      this.manifestPromise = null;
    }
  }

  /** Принудительно перечитывает manifest; при смене release кеш инвалидируется. */
  async reload(): Promise<void> {
    if (this.disposed) return;
    if (this.manifestPromise) await this.manifestPromise;
    this.unavailable = false;
    this.fatalError = null;
    this.started = true;
    this.manifestPromise = this.loadManifest();
    try {
      await this.manifestPromise;
    } finally {
      this.manifestPromise = null;
    }
  }

  private async loadManifest(): Promise<void> {
    this.setStarted();
    this.fatalError = null;
    this.unavailable = false;
    this.setState('loading');
    const controller = new AbortController();
    this.manifestController?.abort();
    this.manifestController = controller;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.disposed || controller.signal.aborted) return;
      try {
        const { text } = await this.fetchText(this.manifestUrl, controller.signal);
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new Error('manifest.json содержит некорректный JSON');
        }
        const validation = validateManifest(raw, MOBILITY_VERSION);
        for (const issue of validation.issues) this.pushNote(issue);
        if (!validation.ok || !validation.manifest) {
          this.fatalError = validation.issues.join('; ');
          this.setState('error');
          this.options.onError?.(`mobility: ${this.fatalError}`);
          return;
        }
        this.installManifest(validation.manifest);
        return;
      } catch (error) {
        if (this.disposed || controller.signal.aborted || isAbortError(error)) return;
        lastError = error;
        if (error instanceof HttpStatusError && error.status === 404) {
          this.unavailable = true;
          this.pushNote('данные mobility не найдены (HTTP 404): слой отключён, карта работает');
          this.setState('unavailable');
          this.options.onError?.('mobility: данные /data/mobility не найдены (HTTP 404)');
          return;
        }
        if (attempt === 0) await delay(this.retryDelayMs);
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    this.pushNote(`manifest не загружен: ${message}`);
    this.setState(this.unavailable ? 'unavailable' : 'error');
    this.options.onError?.(`mobility: manifest не загружен: ${message}`);
  }

  private installManifest(manifest: MobilityManifest): void {
    const nextKey = mobilityReleaseKey(manifest.release);
    const previousKey = this.releaseKey;
    const releaseChanged = previousKey !== null && previousKey !== nextKey;
    if (releaseChanged) {
      this.invalidateCaches('релиз mobility изменился: кеш chunks/маршрутов сброшен');
    }
    this.manifest = manifest;
    this.releaseKey = nextKey;
    this.unavailable = false;
    this.fatalError = null;
    // Тот же релиз: загруженные chunks остаются валидными. Новый релиз уже
    // очистил кеш через invalidateCaches выше. Состояние обновится в update().
    this.chunkRevision += 1;
    this.setState('loading');
  }

  // -------------------------------------------------------------------------
  // область камеры -> chunks
  // -------------------------------------------------------------------------

  /**
   * Планирует загрузку chunks по области камеры (локальные метры, x восток,
   * y север). Вызывается каждый кадр/тик; тяжёлый пересчёт — только при
   * смещении больше четверти chunkSize.
   */
  update(rect: MobilityLoadRect): void {
    if (this.disposed || !this.manifest) return;
    if (!isValidLoadRect(rect)) return;
    this.hasUpdated = true;
    const chunkSize = this.manifest.chunkSize;
    const centreX = (rect.minX + rect.maxX) * 0.5;
    const centreY = (rect.minY + rect.maxY) * 0.5;
    const last = this.lastRect;
    const moved =
      last === null ||
      Math.abs((last.minX + last.maxX) * 0.5 - centreX) > chunkSize * 0.25 ||
      Math.abs((last.minY + last.maxY) * 0.5 - centreY) > chunkSize * 0.25 ||
      Math.abs((last.maxX - last.minX) - (rect.maxX - rect.minX)) > chunkSize * 0.25 ||
      Math.abs((last.maxY - last.minY) - (rect.maxY - rect.minY)) > chunkSize * 0.25;
    if (!moved) {
      this.markDesiredUsed();
      this.trimChunks();
      // Повтор упавших chunks после retryFailedAfterMs происходит и без движения
      // камеры; новые запросы ограничены лимитами pumpChunks.
      this.pumpChunks();
      this.refreshState();
      return;
    }
    this.lastRect = { ...rect };
    this.desiredChunks = selectChunksForRect(this.manifest.chunks, rect, {
      marginM: this.chunkMarginM,
      maxChunks: this.maxChunks,
      maxBytes: this.maxChunkBytes > 0 ? this.maxChunkBytes : undefined,
    });
    this.desiredKeys = new Set(this.desiredChunks.map((entry) => entry.key));
    // Запросы, вышедшие из области, больше не нужны — отменяем fetch.
    for (const [key, task] of this.inflightChunks) {
      if (!this.desiredKeys.has(key)) {
        task.controller.abort();
        this.inflightChunks.delete(key);
      }
    }
    this.markDesiredUsed();
    this.trimChunks();
    this.pumpChunks();
    this.refreshState();
  }

  private markDesiredUsed(): void {
    const now = nowMs();
    for (const key of this.desiredKeys) {
      const loaded = this.chunks.get(key);
      if (loaded) loaded.lastUsed = now;
    }
  }

  private pumpChunks(): void {
    if (this.disposed || !this.manifest) return;
    while (this.inflightChunks.size < this.maxConcurrentChunks) {
      const next = this.desiredChunks.find((entry) => {
        if (this.chunks.has(entry.key) || this.inflightChunks.has(entry.key)) return false;
        const failedAt = this.failedChunks.get(entry.key);
        if (failedAt !== undefined && nowMs() - failedAt < this.retryFailedAfterMs) return false;
        return true;
      });
      if (!next) break;
      if (this.chunks.size + this.inflightChunks.size >= this.maxChunks) break;
      const estimated = Math.max(0, next.bytes);
      if (
        this.maxChunkBytes > 0 &&
        this.chunks.size > 0 &&
        this.estimatedBytes() + estimated > this.maxChunkBytes
      ) {
        // Бюджет занят чанками прошлых видов камеры. Раньше здесь был просто
        // break: лимит не превышен, поэтому trimChunks ничего не выгружал, а
        // новые чанки области никогда не запрашивались — маршруты навсегда
        // оставались на хордах. Освобождаем LRU-чанки вне текущего окна.
        let evicted = false;
        while (this.estimatedBytes() + estimated > this.maxChunkBytes) {
          if (!this.evictOldestUndesired()) break;
          evicted = true;
        }
        if (evicted) this.options.onChunksChanged?.();
        if (this.estimatedBytes() + estimated > this.maxChunkBytes) break;
      }
      this.startChunkLoad(next);
    }
  }

  /**
   * Выгружает один самый старый chunk вне текущего окна; false — нечего.
   * Уведомление `onChunksChanged` делает вызывающий код (пачкой на несколько
   * выгрузок), чтобы переезд камеры не пересобирал индекс на каждый chunk.
   */
  private evictOldestUndesired(): boolean {
    let victimKey: string | null = null;
    let victimUsed = Number.POSITIVE_INFINITY;
    for (const [key, loaded] of this.chunks) {
      if (this.desiredKeys.has(key)) continue;
      if (loaded.lastUsed < victimUsed) {
        victimUsed = loaded.lastUsed;
        victimKey = key;
      }
    }
    if (victimKey === null) return false;
    const loaded = this.chunks.get(victimKey);
    if (!loaded) return false;
    this.chunks.delete(victimKey);
    this.loadedBytesCount = Math.max(0, this.loadedBytesCount - loaded.bytes);
    this.signalNodesCache = null;
    this.chunkRevision += 1;
    return true;
  }

  private estimatedBytes(): number {
    let bytes = this.loadedBytesCount;
    for (const task of this.inflightChunks.values()) {
      if (Number.isFinite(task.index.bytes)) bytes += Math.max(0, task.index.bytes);
    }
    return bytes;
  }

  private startChunkLoad(entry: MobilityChunkIndex): void {
    const controller = new AbortController();
    this.inflightChunks.set(entry.key, { index: entry, controller });
    this.requestCount += 1;
    void this.loadChunk(entry, controller);
  }

  private async loadChunk(entry: MobilityChunkIndex, controller: AbortController): Promise<void> {
    try {
      const url = mobilityFilePath(this.baseUrl, entry.file);
      const { text, bytes } = await this.fetchText(url, controller.signal);
      if (this.disposed || controller.signal.aborted) return;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        this.recordChunkFailure(entry.key, `chunk ${entry.key}: некорректный JSON`);
        return;
      }
      const validation = validateChunkPayload(raw, entry);
      for (const issue of validation.issues) this.pushNote(issue);
      if (!validation.ok || !validation.chunk) {
        // Версия/ключ/bounds: данные нельзя смешивать — переводим слой в error,
        // но карта продолжает работать (слой просто пуст).
        if (validation.fatal) {
          this.fatalError = validation.issues.join('; ');
          this.setState('error');
          this.options.onError?.(`mobility: ${this.fatalError}`);
          return;
        }
        this.recordChunkFailure(entry.key, validation.issues.join('; '));
        return;
      }
      this.chunks.set(entry.key, {
        index: entry,
        chunk: validation.chunk,
        bytes,
        lastUsed: nowMs(),
      });
      this.loadedBytesCount += bytes;
      this.failedChunks.delete(entry.key);
      this.signalNodesCache = null;
      this.chunkRevision += 1;
      this.options.onChunksChanged?.();
      this.trimChunks();
    } catch (error) {
      if (this.disposed || controller.signal.aborted || isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.recordChunkFailure(entry.key, `chunk ${entry.key}: ${message}`);
    } finally {
      this.inflightChunks.delete(entry.key);
      this.pumpChunks();
      this.trimChunks();
      this.refreshState();
      this.resolveIdle();
    }
  }

  private recordChunkFailure(key: string, message: string): void {
    this.failedChunks.set(key, nowMs());
    this.pushNote(message);
  }

  private trimChunks(): void {
    const overCount = (): boolean => this.chunks.size > this.maxChunks;
    const overBytes = (): boolean => this.maxChunkBytes > 0 && this.loadedBytesCount > this.maxChunkBytes;
    while (overCount() || overBytes()) {
      let victimKey: string | null = null;
      let victimUsed = Number.POSITIVE_INFINITY;
      for (const [key, loaded] of this.chunks) {
        if (this.desiredKeys.has(key)) continue;
        if (loaded.lastUsed < victimUsed) {
          victimUsed = loaded.lastUsed;
          victimKey = key;
        }
      }
      if (victimKey === null) break;
      const loaded = this.chunks.get(victimKey);
      if (!loaded) break;
      this.chunks.delete(victimKey);
      this.loadedBytesCount = Math.max(0, this.loadedBytesCount - loaded.bytes);
      this.signalNodesCache = null;
      this.chunkRevision += 1;
      this.options.onChunksChanged?.();
    }
  }

  // -------------------------------------------------------------------------
  // маршруты по требованию
  // -------------------------------------------------------------------------

  /** Загружает файлы вариантов (вариант + рейсы) по их id. Ошибки — в notes. */
  async ensureRoutes(ids: readonly string[]): Promise<void> {
    if (this.disposed || !this.manifest) return;
    const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
    this.requestedRouteIds = new Set(unique);
    await Promise.all(unique.map((id) => this.loadRoute(id)));
    this.trimRoutes();
    this.refreshState();
    this.resolveIdle();
  }

  /** Выбирает и загружает варианты, чьи bounds пересекают область камеры. */
  async ensureRoutesForRect(rect: MobilityLoadRect): Promise<void> {
    if (this.disposed || !this.manifest || !isValidLoadRect(rect)) return;
    const entries = selectRoutesForRect(this.manifest.routes, rect, {
      marginM: this.routeMarginM,
      maxRoutes: this.maxVariantFiles,
      verifiedOnly: this.verifiedRoutesOnly,
    });
    await this.ensureRoutes(entries.map((entry) => entry.id));
  }

  private routeCacheKey(id: string): string {
    return mobilityRouteCacheKey(this.releaseKey ?? '', id);
  }

  private loadRoute(id: string): Promise<void> {
    if (this.disposed || !this.manifest) return Promise.resolve();
    const cacheKey = this.routeCacheKey(id);
    if (this.routes.has(cacheKey)) {
      const cached = this.routes.get(cacheKey);
      if (cached) cached.lastUsed = nowMs();
      return Promise.resolve();
    }
    const existing = this.inflightRoutes.get(id);
    if (existing) return existing;
    const failedAt = this.failedRoutes.get(id);
    if (failedAt !== undefined && nowMs() - failedAt < this.retryFailedAfterMs) return Promise.resolve();
    const skippedAt = this.skippedRoutes.get(id);
    if (skippedAt !== undefined && nowMs() - skippedAt < this.retryFailedAfterMs) return Promise.resolve();
    const entry = this.manifest.routes.find((candidate) => candidate.id === id);
    if (!entry) {
      this.pushNote(`вариант ${id} отсутствует в индексе manifest`);
      this.skippedRoutes.set(id, nowMs());
      return Promise.resolve();
    }
    if (this.verifiedRoutesOnly && entry.verified !== true) {
      this.pushNote(`вариант ${id} не прошёл аудит: загрузка пропущена`);
      this.skippedRoutes.set(id, nowMs());
      return Promise.resolve();
    }
    this.ensureRouteCapacity(entry);
    const controller = new AbortController();
    this.inflightRouteControllers.set(id, controller);
    const task = (async (): Promise<void> => {
      try {
        const url = mobilityFilePath(this.baseUrl, entry.file);
        const { text, bytes } = await this.fetchText(url, controller.signal);
        if (this.disposed || controller.signal.aborted) return;
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          this.recordRouteFailure(id, `вариант ${id}: некорректный JSON`);
          return;
        }
        const validation = validateRouteFile(raw, {
          id,
          stops: entry.stops,
          trips: entry.trips,
          mode: entry.mode,
        });
        for (const issue of validation.issues) this.pushNote(issue);
        if (!validation.ok || !validation.route) {
          if (validation.fatal) {
            this.fatalError = validation.issues.join('; ');
            this.setState('error');
            this.options.onError?.(`mobility: ${this.fatalError}`);
            return;
          }
          this.recordRouteFailure(id, validation.issues.join('; '));
          return;
        }
        if (this.maxRouteBytes > 0 && this.routeBytesCount + bytes > this.maxRouteBytes && this.routes.size > 0) {
          this.pushNote(`вариант ${id}: превышен лимит байт маршрутов, файл не кеширован`);
          this.skippedRoutes.set(id, nowMs());
          return;
        }
        this.routes.set(cacheKey, {
          index: entry,
          file: validation.route,
          bytes,
          lastUsed: nowMs(),
        });
        this.routeBytesCount += bytes;
        this.failedRoutes.delete(id);
        this.skippedRoutes.delete(id);
        this.options.onRoutesChanged?.();
        this.trimRoutes();
      } catch (error) {
        if (this.disposed || controller.signal.aborted || isAbortError(error)) return;
        const message = error instanceof Error ? error.message : String(error);
        this.recordRouteFailure(id, `вариант ${id}: ${message}`);
      } finally {
        this.inflightRoutes.delete(id);
        this.inflightRouteControllers.delete(id);
        this.resolveIdle();
      }
    })();
    this.inflightRoutes.set(id, task);
    return task;
  }

  private recordRouteFailure(id: string, message: string): void {
    this.failedRoutes.set(id, nowMs());
    this.pushNote(message);
  }

  private ensureRouteCapacity(next: MobilityRouteIndexEntry): void {
    if (this.routes.size < this.maxVariantFiles) return;
    let victimId: string | null = null;
    let victimUsed = Number.POSITIVE_INFINITY;
    for (const [key, loaded] of this.routes) {
      const id = loaded.index.id;
      if (this.requestedRouteIds.has(id) || id === next.id) continue;
      if (loaded.lastUsed < victimUsed) {
        victimUsed = loaded.lastUsed;
        victimId = key;
      }
    }
    if (victimId === null) {
      // Все кешированные варианты затребованы: уступаем самому старому.
      for (const [key, loaded] of this.routes) {
        if (loaded.lastUsed < victimUsed) {
          victimUsed = loaded.lastUsed;
          victimId = key;
        }
      }
    }
    if (victimId !== null) {
      const loaded = this.routes.get(victimId);
      if (loaded) {
        this.routes.delete(victimId);
        this.routeBytesCount = Math.max(0, this.routeBytesCount - loaded.bytes);
        this.options.onRoutesChanged?.();
      }
    }
  }

  private trimRoutes(): void {
    if (this.routes.size <= this.maxVariantFiles) return;
    const entries = [...this.routes.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.routes.size > this.maxVariantFiles && entries.length > 0) {
      const [key, loaded] = entries.shift() as [string, LoadedRoute];
      if (this.requestedRouteIds.has(loaded.index.id)) continue;
      this.routes.delete(key);
      this.routeBytesCount = Math.max(0, this.routeBytesCount - loaded.bytes);
      this.options.onRoutesChanged?.();
    }
  }

  // -------------------------------------------------------------------------
  // чтение загруженного
  // -------------------------------------------------------------------------

  /** Загруженные chunks в порядке загрузки (для QA; не для рендера). */
  getChunks(): readonly MobilityChunk[] {
    return [...this.chunks.values()].map((loaded) => loaded.chunk);
  }

  /** Файл варианта по id (пути/рейсы), либо null. */
  getVariant(id: string): MobilityRouteFile | null {
    return this.routes.get(mobilityRouteCacheKey(this.releaseKey ?? '', id))?.file ?? null;
  }

  /** Загружен ли файл варианта. */
  hasVariant(id: string): boolean {
    return this.routes.has(mobilityRouteCacheKey(this.releaseKey ?? '', id));
  }

  /**
   * Светофоры из загруженных chunks в порядке manifest.signalNodes (детерминизм).
   * Не проиндексированные/лишние узлы добавляются после, отсортированные по id.
   * Результат кешируется до смены набора chunks; вызывающий не должен мутировать.
   */
  getSignalNodes(): readonly MobilitySignalNode[] {
    if (this.signalNodesCache) return this.signalNodesCache;
    const nodes: MobilitySignalNode[] = [];
    const seen = new Set<string>();
    const byChunk = new Map<string, Map<string, MobilitySignalNode>>();
    for (const [key, loaded] of this.chunks) {
      const map = new Map<string, MobilitySignalNode>();
      for (const node of loaded.chunk.signals) map.set(node.id, node);
      byChunk.set(key, map);
    }
    for (const ref of this.manifest?.signalNodes ?? []) {
      const node = byChunk.get(ref.chunk)?.get(ref.id);
      if (node && !seen.has(node.id)) {
        seen.add(node.id);
        nodes.push(node);
      }
    }
    const leftovers: MobilitySignalNode[] = [];
    for (const map of byChunk.values()) {
      for (const node of map.values()) {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          leftovers.push(node);
        }
      }
    }
    leftovers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    nodes.push(...leftovers);
    this.signalNodesCache = nodes;
    return nodes;
  }

  /** Разрешается, когда все запросы chunks/маршрутов завершились (для тестов/QA). */
  whenIdle(): Promise<void> {
    if (this.inflightChunks.size === 0 && this.inflightRoutes.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private resolveIdle(): void {
    if (this.inflightChunks.size > 0 || this.inflightRoutes.size > 0) return;
    while (this.idleWaiters.length > 0) {
      const resolve = this.idleWaiters.pop();
      resolve?.();
    }
  }

  // -------------------------------------------------------------------------
  // состояние / жизненный цикл
  // -------------------------------------------------------------------------

  private setStarted(): void {
    this.started = true;
  }

  private setState(next: MobilityDataState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.options.onStateChange?.(next);
  }

  private pushNote(message: string): void {
    if (!message) return;
    if (this.notes.includes(message)) return;
    this.notes.push(message);
    if (this.notes.length > 32) this.notes.splice(0, this.notes.length - 32);
  }

  private refreshState(): void {
    if (this.disposed) return;
    if (this.fatalError) {
      this.setState('error');
      return;
    }
    if (!this.manifest) {
      if (this.unavailable) this.setState('unavailable');
      else this.setState('idle');
      return;
    }
    if (!this.hasUpdated) {
      this.setState('loading');
      return;
    }
    if (this.failedChunks.size > 0 || this.failedRoutes.size > 0) {
      this.setState('partial');
      return;
    }
    const missing = this.desiredChunks.some((entry) => !this.chunks.has(entry.key));
    if (missing) {
      this.setState(this.inflightChunks.size > 0 ? 'loading' : 'partial');
      return;
    }
    this.setState('ready');
  }

  /**
   * Сбрасывает кеш chunks/маршрутов (например, при смене релиза или даты
   * обслуживания). Незавершённые запросы отменяются, состояние — `loading`.
   */
  invalidate(reason: string): void {
    if (this.disposed) return;
    this.invalidateCaches(reason);
    this.pushNote(reason);
    this.refreshState();
  }

  private invalidateCaches(reason: string): void {
    for (const task of this.inflightChunks.values()) task.controller.abort();
    this.inflightChunks.clear();
    for (const controller of this.inflightRouteControllers.values()) controller.abort();
    this.inflightRouteControllers.clear();
    this.inflightRoutes.clear();
    this.manifestController?.abort();
    this.manifestController = null;
    this.chunks.clear();
    this.routes.clear();
    this.failedChunks.clear();
    this.failedRoutes.clear();
    this.skippedRoutes.clear();
    this.requestedRouteIds = new Set();
    this.desiredChunks = [];
    this.desiredKeys = new Set();
    this.lastRect = null;
    this.loadedBytesCount = 0;
    this.routeBytesCount = 0;
    this.signalNodesCache = null;
    this.hasUpdated = false;
    this.chunkRevision += 1;
    this.options.onChunksChanged?.();
    this.options.onRoutesChanged?.();
    this.pushNote(reason);
    this.resolveIdle();
  }

  private async fetchText(
    url: string,
    signal: AbortSignal,
  ): Promise<{ text: string; bytes: number }> {
    const response = await this.fetchImpl(url, { cache: 'no-cache', signal });
    if (!response.ok) throw new HttpStatusError(response.status, url);
    const text = await response.text();
    return { text, bytes: byteLength(text) };
  }

  /** Отменяет все запросы и освобождает кеш. Повторный вызов безопасен. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.manifestController?.abort();
    this.manifestController = null;
    for (const task of this.inflightChunks.values()) task.controller.abort();
    this.inflightChunks.clear();
    for (const controller of this.inflightRouteControllers.values()) controller.abort();
    this.inflightRouteControllers.clear();
    this.inflightRoutes.clear();
    this.chunks.clear();
    this.routes.clear();
    this.failedChunks.clear();
    this.failedRoutes.clear();
    this.skippedRoutes.clear();
    this.signalNodesCache = null;
    this.loadedBytesCount = 0;
    this.routeBytesCount = 0;
    this.resolveIdle();
    this.setState('idle');
  }
}

/** Публичный URL manifest по каталогу данных. */
export function mobilityManifestUrl(baseUrl: string = MOBILITY_DATA_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, '')}/manifest.json`;
}

/**
 * Удобный ре-экспорт для интеграции в `createCityApp`: камера отдаёт world XZ,
 * загрузчик ждёт локальные метры.
 */
export { worldRectToLoadRect } from './loaderCore';
export type { MobilityLoadRect } from './loaderCore';


