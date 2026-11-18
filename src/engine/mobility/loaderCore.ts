/**
 * Isometric Minsk — чистые функции загрузчика мобильности.
 *
 * Здесь нет `fetch`, таймеров и Three.js: выбор chunks/routes по области,
 * ключи кеша, проверки версии/релиза и разбор payload. Это позволяет проверять
 * логику загрузчика в unit-тестах без сети и без браузера; сам `MobilityLoader`
 * (см. `loader.ts`) остаётся тонкой обвязкой над этими функциями.
 *
 * Система координат области загрузки — ЛОКАЛЬНЫЕ МЕТРЫ контракта мобильности:
 * x на восток, y на север (не world XZ камеры). Для камеры используйте
 * `worldRectToLoadRect()`.
 */

import {
  MOBILITY_VERSION,
  type MobilityChunk,
  type MobilityChunkIndex,
  type MobilityManifest,
  type MobilityMode,
  type MobilityReleaseIdentity,
  type MobilityRouteFile,
  type MobilityRouteIndexEntry,
  type MobilityScheduleStatus,
} from '../../shared/mobility';

/** Прямоугольник в локальных метрах: x восток, y север. */
export interface MobilityLoadRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Прямоугольник видимой земли в world XZ (форма `GroundRect` камеры). */
export interface MobilityWorldRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const EPSILON = 1e-6;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBounds(value: unknown): value is [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) return false;
  if (!value.every(isFiniteNumber)) return false;
  return value[0] <= value[2] && value[1] <= value[3];
}

/** Проверка прямоугольника загрузки; пустая область (min == max) допустима. */
export function isValidLoadRect(rect: unknown): rect is MobilityLoadRect {
  if (!rect || typeof rect !== 'object') return false;
  const candidate = rect as Partial<MobilityLoadRect>;
  if (
    !isFiniteNumber(candidate.minX) ||
    !isFiniteNumber(candidate.maxX) ||
    !isFiniteNumber(candidate.minY) ||
    !isFiniteNumber(candidate.maxY)
  ) {
    return false;
  }
  return candidate.minX <= candidate.maxX && candidate.minY <= candidate.maxY;
}

/** world XZ камеры -> локальные метры (x восток, y север = −worldZ). */
export function worldRectToLoadRect(rect: MobilityWorldRect): MobilityLoadRect {
  return {
    minX: Math.min(rect.minX, rect.maxX),
    maxX: Math.max(rect.minX, rect.maxX),
    minY: -Math.max(rect.minZ, rect.maxZ),
    maxY: -Math.min(rect.minZ, rect.maxZ),
  };
}

/** Расширение области на запас (торможение/видимость), метры; отрицательный -> 0. */
export function expandLoadRect(rect: MobilityLoadRect, marginM: number): MobilityLoadRect {
  const margin = Number.isFinite(marginM) ? Math.max(0, marginM) : 0;
  return {
    minX: rect.minX - margin,
    maxX: rect.maxX + margin,
    minY: rect.minY - margin,
    maxY: rect.maxY + margin,
  };
}

/** Пересечение bounds `[minX,minY,maxX,maxY]` с прямоугольником. */
export function boundsIntersectRect(
  bounds: readonly [number, number, number, number],
  rect: MobilityLoadRect,
): boolean {
  return !(
    bounds[2] < rect.minX ||
    bounds[0] > rect.maxX ||
    bounds[3] < rect.minY ||
    bounds[1] > rect.maxY
  );
}

/** Расстояние от центра прямоугольника до bounds, метры (0 при пересечении). */
export function boundsDistanceToRect(
  bounds: readonly [number, number, number, number],
  rect: MobilityLoadRect,
): number {
  const dx = Math.max(bounds[0] - rect.maxX, rect.minX - bounds[2], 0);
  const dy = Math.max(bounds[1] - rect.maxY, rect.minY - bounds[3], 0);
  return Math.hypot(dx, dy);
}

/** Расстояние между центрами прямоугольника загрузки и bounds. */
function centreDistance(
  bounds: readonly [number, number, number, number],
  rect: MobilityLoadRect,
): number {
  const cx = (rect.minX + rect.maxX) * 0.5;
  const cy = (rect.minY + rect.maxY) * 0.5;
  return Math.hypot((bounds[0] + bounds[2]) * 0.5 - cx, (bounds[1] + bounds[3]) * 0.5 - cy);
}

export interface ChunkSelectionOptions {
  /** Запас вокруг области камеры, метры. По умолчанию 0. */
  marginM?: number;
  /** Жёсткий лимит количества chunks (минимум 1). По умолчанию без лимита. */
  maxChunks?: number;
  /** Лимит суммы `bytes` из индекса (минимум один chunk всё равно выбирается). */
  maxBytes?: number;
}

/**
 * Chunks, пересекающие прямоугольник с запасом, ближайшие первыми.
 *
 * Сортировка детерминирована: расстояние до центра области, затем ключ. Именно
 * эта функция не даёт загрузить весь город: вне области камеры+запас ничего не
 * выбирается, а лимиты ограничивают даже широкий обзор.
 */
export function selectChunksForRect(
  chunks: readonly MobilityChunkIndex[],
  rect: MobilityLoadRect,
  options: ChunkSelectionOptions = {},
): MobilityChunkIndex[] {
  if (!isValidLoadRect(rect) || !Array.isArray(chunks)) return [];
  const expanded = expandLoadRect(rect, options.marginM ?? 0);
  const maxChunks = Number.isFinite(options.maxChunks)
    ? Math.max(1, Math.floor(options.maxChunks as number))
    : Number.POSITIVE_INFINITY;
  const maxBytes = Number.isFinite(options.maxBytes) && (options.maxBytes as number) > 0
    ? (options.maxBytes as number)
    : 0;
  const candidates: { entry: MobilityChunkIndex; distance: number; centre: number }[] = [];
  for (const entry of chunks) {
    if (!entry || !Array.isArray(entry.bounds) || !isBounds(entry.bounds)) continue;
    if (!boundsIntersectRect(entry.bounds, expanded)) continue;
    candidates.push({
      entry,
      distance: boundsDistanceToRect(entry.bounds, expanded),
      centre: centreDistance(entry.bounds, rect),
    });
  }
  candidates.sort((a, b) => {
    if (a.centre !== b.centre) return a.centre - b.centre;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0;
  });
  const selected: MobilityChunkIndex[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (selected.length >= maxChunks) break;
    const entryBytes = isFiniteNumber(candidate.entry.bytes) ? Math.max(0, candidate.entry.bytes) : 0;
    if (maxBytes > 0 && selected.length > 0 && bytes + entryBytes > maxBytes) continue;
    selected.push(candidate.entry);
    bytes += entryBytes;
  }
  return selected;
}

export interface RouteSelectionOptions {
  /** Запас вокруг области камеры, метры. По умолчанию 0. */
  marginM?: number;
  /** Лимит числа файлов вариантов. */
  maxRoutes?: number;
  /** Только проверенные варианты (по контракту непроверенные не показываются). */
  verifiedOnly?: boolean;
}

/**
 * Варианты, чьи bounds пересекают область с запасом, ближайшие первыми.
 * Непроверенные по умолчанию исключаются: контракт разрешает не показывать их.
 */
export function selectRoutesForRect(
  routes: readonly MobilityRouteIndexEntry[],
  rect: MobilityLoadRect,
  options: RouteSelectionOptions = {},
): MobilityRouteIndexEntry[] {
  if (!isValidLoadRect(rect) || !Array.isArray(routes)) return [];
  const expanded = expandLoadRect(rect, options.marginM ?? 0);
  const maxRoutes = Number.isFinite(options.maxRoutes)
    ? Math.max(1, Math.floor(options.maxRoutes as number))
    : Number.POSITIVE_INFINITY;
  const verifiedOnly = options.verifiedOnly ?? true;
  const candidates: { entry: MobilityRouteIndexEntry; centre: number }[] = [];
  for (const entry of routes) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.file !== 'string') continue;
    if (verifiedOnly && entry.verified !== true) continue;
    if (!isBounds(entry.bounds)) continue;
    if (!boundsIntersectRect(entry.bounds, expanded)) continue;
    candidates.push({ entry, centre: centreDistance(entry.bounds, rect) });
  }
  candidates.sort((a, b) => {
    if (a.centre !== b.centre) return a.centre - b.centre;
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });
  return candidates.slice(0, maxRoutes).map((candidate) => candidate.entry);
}

/** Короткая строка идентичности релиза (для логов/QA, не для ключа кеша). */
export function mobilityReleaseLabel(release: MobilityReleaseIdentity, generatedAt?: string): string {
  const network = release.network.length > 8 ? release.network.slice(0, 8) : release.network;
  const schedule = release.schedule.length > 12 ? release.schedule.slice(0, 12) : release.schedule;
  const date = generatedAt ? ` · ${generatedAt}` : '';
  return `net ${network} · sched ${schedule}${date}`;
}

/** Стабильный ключ релиза; входит в ключи кеша. */
export function mobilityReleaseKey(release: MobilityReleaseIdentity): string {
  return `${release.network}|${release.schedule}|${release.bindings}`;
}

/** Полное совпадение релиза (все три компонента). */
export function sameMobilityRelease(a: MobilityReleaseIdentity, b: MobilityReleaseIdentity): boolean {
  return a.network === b.network && a.schedule === b.schedule && a.bindings === b.bindings;
}

/** Ключ кеша chunk: релиз + ключ chunk (инвалидация по release). */
export function mobilityChunkCacheKey(releaseKey: string, chunkKey: string): string {
  return `${releaseKey}::chunk:${chunkKey}`;
}

/** Ключ кеша варианта маршрута: релиз + id варианта. */
export function mobilityRouteCacheKey(releaseKey: string, variantId: string): string {
  return `${releaseKey}::route:${variantId}`;
}

/** URL файла данных: относительный путь от baseUrl, абсолютный — как есть. */
export function mobilityFilePath(baseUrl: string, file: string): string {
  if (/^https?:/i.test(file) || file.startsWith('/')) return file;
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/${file.replace(/^\/+/, '')}`;
}

export interface ManifestValidation {
  /** Структура пригодна для работы (fatal-проблем нет). */
  ok: boolean;
  /** Несовместимость версии/идентичности: кеш и загрузка не запускаются. */
  fatal: boolean;
  issues: string[];
  /** Нормализованная копия с отфильтрованными некорректными записями. */
  manifest: MobilityManifest | null;
}

function isRelease(value: unknown): value is MobilityReleaseIdentity {
  if (!value || typeof value !== 'object') return false;
  const release = value as Partial<MobilityReleaseIdentity>;
  return (
    typeof release.network === 'string' && release.network.length > 0 &&
    typeof release.schedule === 'string' && release.schedule.length > 0 &&
    typeof release.bindings === 'string' && release.bindings.length > 0
  );
}

const SCHEDULE_STATUSES: readonly MobilityScheduleStatus[] = [
  'ready',
  'partial',
  'unavailable',
  'synthetic',
  'absent',
];

/**
 * Проверка `scheduleStatus`. Отсутствие поля не ломает загрузку (старые
 * снимки до появления поля): считаем расписание отсутствующим и пишем issue.
 */
function parseScheduleStatus(value: unknown, issues: string[]): MobilityScheduleStatus {
  if (typeof value === 'string' && (SCHEDULE_STATUSES as readonly string[]).includes(value)) {
    return value as MobilityScheduleStatus;
  }
  issues.push('manifest.scheduleStatus отсутствует или неизвестен: считаем расписание отсутствующим');
  return 'absent';
}

function isChunkIndexEntry(entry: unknown): entry is MobilityChunkIndex {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<MobilityChunkIndex>;
  return (
    typeof candidate.key === 'string' && candidate.key.length > 0 &&
    typeof candidate.file === 'string' && candidate.file.length > 0 &&
    isBounds(candidate.bounds) &&
    isFiniteNumber(candidate.bytes) && candidate.bytes >= 0
  );
}

function isRouteIndexEntry(entry: unknown): entry is MobilityRouteIndexEntry {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<MobilityRouteIndexEntry>;
  return (
    typeof candidate.id === 'string' && candidate.id.length > 0 &&
    typeof candidate.file === 'string' && candidate.file.length > 0 &&
    isBounds(candidate.bounds) &&
    typeof candidate.verified === 'boolean'
  );
}

function isSignalNodeRef(entry: unknown): entry is MobilityManifest['signalNodes'][number] {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<MobilityManifest['signalNodes'][number]>;
  return (
    typeof candidate.id === 'string' && candidate.id.length > 0 &&
    isFiniteNumber(candidate.x) && isFiniteNumber(candidate.y) &&
    typeof candidate.chunk === 'string'
  );
}

/**
 * Проверка и нормализация manifest.
 *
 * Fatal: не объект, чужая версия `MOBILITY_VERSION`, отсутствующий/пустой
 * release, нечисловой `chunkSize`/`bounds`/`originUtm`. Некорректные записи
 * chunks/routes/signalNodes не валят карту: они отбрасываются с записью в
 * `issues`, чтобы состояние было `partial`, а не `error`.
 */
export function validateManifest(raw: unknown, expectedVersion = MOBILITY_VERSION): ManifestValidation {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, fatal: true, issues: ['manifest не является объектом'], manifest: null };
  }
  const source = raw as Record<string, unknown>;
  if (source.version !== expectedVersion) {
    return {
      ok: false,
      fatal: true,
      issues: [`несовместимая версия mobility: ${String(source.version)}, ожидается ${expectedVersion}`],
      manifest: null,
    };
  }
  if (!isRelease(source.release)) {
    return {
      ok: false,
      fatal: true,
      issues: ['manifest.release отсутствует или пуст: нельзя различить версии данных'],
      manifest: null,
    };
  }
  if (!isFiniteNumber(source.chunkSize) || source.chunkSize <= 0) {
    return { ok: false, fatal: true, issues: ['manifest.chunkSize должен быть положительным числом'], manifest: null };
  }
  if (!isBounds(source.bounds)) {
    return { ok: false, fatal: true, issues: ['manifest.bounds должен быть [minX,minY,maxX,maxY]'], manifest: null };
  }
  if (!Array.isArray(source.originUtm) || source.originUtm.length !== 2 || !source.originUtm.every(isFiniteNumber)) {
    return { ok: false, fatal: true, issues: ['manifest.originUtm должен быть парой чисел'], manifest: null };
  }
  if (!Array.isArray(source.chunks)) {
    return { ok: false, fatal: true, issues: ['manifest.chunks должен быть массивом'], manifest: null };
  }
  const chunks = source.chunks.filter(isChunkIndexEntry);
  if (chunks.length !== source.chunks.length) {
    issues.push(`в manifest отброшено некорректных chunks: ${source.chunks.length - chunks.length}`);
  }
  // Ключ chunk обязан быть уникальным (bounds заявляет ровно один chunk).
  const uniqueChunks: MobilityChunkIndex[] = [];
  const chunkKeys = new Set<string>();
  let duplicateChunks = 0;
  for (const entry of chunks) {
    if (chunkKeys.has(entry.key)) {
      duplicateChunks += 1;
      continue;
    }
    chunkKeys.add(entry.key);
    uniqueChunks.push(entry);
  }
  if (duplicateChunks > 0) issues.push(`в manifest дубли ключей chunks: ${duplicateChunks}`);
  const routes = Array.isArray(source.routes) ? source.routes.filter(isRouteIndexEntry) : [];
  if (!Array.isArray(source.routes)) issues.push('manifest.routes отсутствует: маршруты не будут загружаться');
  else if (routes.length !== source.routes.length) {
    issues.push(`в manifest отброшено некорректных routes: ${source.routes.length - routes.length}`);
  }
  const signalNodes = Array.isArray(source.signalNodes) ? source.signalNodes.filter(isSignalNodeRef) : [];
  if (!Array.isArray(source.signalNodes)) {
    issues.push('manifest.signalNodes отсутствует: индекс светофоров не используется');
  } else if (signalNodes.length !== source.signalNodes.length) {
    issues.push(`в manifest отброшено некорректных signalNodes: ${source.signalNodes.length - signalNodes.length}`);
  }
  const calendars = Array.isArray(source.calendars) ? source.calendars : [];
  if (!Array.isArray(source.calendars)) issues.push('manifest.calendars отсутствует');
  if (typeof source.generatedAt !== 'string') issues.push('manifest.generatedAt отсутствует');
  const scheduleStatus = parseScheduleStatus(source.scheduleStatus, issues);
  const manifest: MobilityManifest = {
    version: source.version as number,
    generatedAt: typeof source.generatedAt === 'string' ? source.generatedAt : '',
    epsg: isFiniteNumber(source.epsg) ? source.epsg : 0,
    originUtm: [source.originUtm[0] as number, source.originUtm[1] as number],
    chunkSize: source.chunkSize as number,
    bounds: source.bounds as [number, number, number, number],
    chunks: uniqueChunks,
    routes,
    signalNodes,
    calendars: calendars as MobilityManifest['calendars'],
    release: source.release,
    scheduleStatus,
    ...(typeof source.scheduleNote === 'string' ? { scheduleNote: source.scheduleNote } : {}),
    // Процедурное расписание (городской демо-режим): модель должна дойти до
    // симулятора, иначе он не сможет синтезировать рейсы.
    ...(source.timetableMode === 'procedural' ? { timetableMode: 'procedural' as const } : {}),
    ...(source.timetableMode === 'procedural' &&
    source.syntheticTimetable &&
    typeof source.syntheticTimetable === 'object'
      ? { syntheticTimetable: source.syntheticTimetable as MobilityManifest['syntheticTimetable'] }
      : {}),
    provenance: Array.isArray(source.provenance) ? (source.provenance as MobilityManifest['provenance']) : [],
    counts: (source.counts && typeof source.counts === 'object'
      ? source.counts
      : { edges: 0, stops: 0, signalNodes: 0, variants: 0, trips: 0, verifiedVariants: 0 }) as MobilityManifest['counts'],
  };
  return { ok: true, fatal: false, issues, manifest };
}

export interface ChunkValidation {
  ok: boolean;
  /** Несовместимая версия/чужой chunk: использовать нельзя. */
  fatal: boolean;
  issues: string[];
  chunk: MobilityChunk | null;
}

/**
 * Проверка chunk payload и его идентичности индексу manifest.
 *
 * Fatal: версия, ключ или bounds не совпали с запрошенным индексом (данные
 * релиза перемешаны). Отсутствующие массивы нормализуются в пустые с issue:
 * чужой файл не должен ломать карту.
 */
export function validateChunkPayload(
  raw: unknown,
  expected: Pick<MobilityChunkIndex, 'key' | 'bounds'> & Partial<Pick<MobilityChunkIndex, 'edges' | 'stops' | 'signals'>>,
  expectedVersion = MOBILITY_VERSION,
): ChunkValidation {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, fatal: true, issues: ['chunk не является объектом'], chunk: null };
  }
  const source = raw as Record<string, unknown>;
  if (source.version !== expectedVersion) {
    return {
      ok: false,
      fatal: true,
      issues: [`chunk ${expected.key}: версия ${String(source.version)} вместо ${expectedVersion}`],
      chunk: null,
    };
  }
  if (source.key !== expected.key) {
    return {
      ok: false,
      fatal: true,
      issues: [`chunk: ключ ${String(source.key)} не совпадает с запрошенным ${expected.key}`],
      chunk: null,
    };
  }
  if (!isBounds(source.bounds) || !isBounds(expected.bounds)) {
    return { ok: false, fatal: true, issues: [`chunk ${expected.key}: некорректные bounds`], chunk: null };
  }
  const payloadBounds = source.bounds;
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(payloadBounds[i] - expected.bounds[i]) > 0.001) {
      return {
        ok: false,
        fatal: true,
        issues: [`chunk ${expected.key}: bounds не совпадают с индексом manifest`],
        chunk: null,
      };
    }
  }
  const edges = Array.isArray(source.edges) ? source.edges : [];
  const stops = Array.isArray(source.stops) ? source.stops : [];
  const signals = Array.isArray(source.signals) ? source.signals : [];
  if (!Array.isArray(source.edges)) issues.push(`chunk ${expected.key}: нет массива edges`);
  if (!Array.isArray(source.stops)) issues.push(`chunk ${expected.key}: нет массива stops`);
  if (!Array.isArray(source.signals)) issues.push(`chunk ${expected.key}: нет массива signals`);
  if (isFiniteNumber(expected.edges) && edges.length !== expected.edges) {
    issues.push(`chunk ${expected.key}: edges ${edges.length} вместо ${expected.edges}`);
  }
  if (isFiniteNumber(expected.stops) && stops.length !== expected.stops) {
    issues.push(`chunk ${expected.key}: stops ${stops.length} вместо ${expected.stops}`);
  }
  if (isFiniteNumber(expected.signals) && signals.length !== expected.signals) {
    issues.push(`chunk ${expected.key}: signals ${signals.length} вместо ${expected.signals}`);
  }
  return {
    ok: true,
    fatal: false,
    issues,
    chunk: {
      version: source.version as number,
      key: expected.key,
      bounds: payloadBounds,
      edges: edges as MobilityChunk['edges'],
      stops: stops as MobilityChunk['stops'],
      signals: signals as MobilityChunk['signals'],
    },
  };
}

export interface RouteValidation {
  ok: boolean;
  fatal: boolean;
  issues: string[];
  route: MobilityRouteFile | null;
}

/**
 * Проверка файла варианта маршрута: версия и `variant.id` обязаны совпасть с
 * индексом. Непроверенный вариант не является fatal: решение о показе
 * принимает симуляция/UI, а загрузчик лишь отмечает это в `issues`.
 */
export function validateRouteFile(
  raw: unknown,
  expected: { id: string; stops?: number; trips?: number; mode?: MobilityMode },
  expectedVersion = MOBILITY_VERSION,
): RouteValidation {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, fatal: true, issues: ['файл варианта не является объектом'], route: null };
  }
  const source = raw as Record<string, unknown>;
  if (source.version !== expectedVersion) {
    return {
      ok: false,
      fatal: true,
      issues: [`вариант ${expected.id}: версия ${String(source.version)} вместо ${expectedVersion}`],
      route: null,
    };
  }
  const variant = source.variant as Record<string, unknown> | undefined;
  if (!variant || typeof variant !== 'object' || typeof variant.id !== 'string') {
    return { ok: false, fatal: true, issues: [`вариант ${expected.id}: нет variant.id`], route: null };
  }
  if (variant.id !== expected.id) {
    return {
      ok: false,
      fatal: true,
      issues: [`вариант: id ${variant.id} не совпадает с запрошенным ${expected.id}`],
      route: null,
    };
  }
  const trips = Array.isArray(source.trips) ? source.trips : [];
  if (!Array.isArray(source.trips)) issues.push(`вариант ${expected.id}: нет массива trips`);
  if (isFiniteNumber(expected.trips) && trips.length !== expected.trips) {
    issues.push(`вариант ${expected.id}: рейсов ${trips.length} вместо ${expected.trips}`);
  }
  const stops = Array.isArray(variant.stops) ? variant.stops : [];
  if (!Array.isArray(variant.stops)) issues.push(`вариант ${expected.id}: нет массива stops`);
  if (isFiniteNumber(expected.stops) && stops.length !== expected.stops) {
    issues.push(`вариант ${expected.id}: остановок ${stops.length} вместо ${expected.stops}`);
  }
  if (variant.verified === false) issues.push(`вариант ${expected.id}: не прошёл геометрический аудит`);
  if (expected.mode && variant.mode !== expected.mode) {
    issues.push(`вариант ${expected.id}: mode ${String(variant.mode)} вместо ${expected.mode}`);
  }
  return {
    ok: true,
    fatal: false,
    issues,
    route: {
      version: source.version as number,
      variant: variant as unknown as MobilityRouteFile['variant'],
      trips: trips as MobilityRouteFile['trips'],
    },
  };
}

/** Допуск сравнения границ (метры) для тестов и QA. */
export const MOBILITY_BOUNDS_EPSILON = EPSILON;
