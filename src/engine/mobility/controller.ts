/**
 * Isometric Minsk — интеграция мобильности: загрузка, часы, симуляция, рендер.
 *
 * Контроллер — единственное место, где встречаются три слоя:
 *   - `MobilityLoader` (данные, кеш по области камеры, release-инвалидация);
 *   - `src/mobility/*` (чистые часы, расписание, светофоры, рейсы);
 *   - `MobilityLayer` (Three.js инстансы, LOD, бюджеты, dispose).
 *
 * Порядок одного кадра:
 *   1. `loader.update(rect)` — планирует chunks вокруг камеры (сам fetch асинхронный);
 *   2. `clock.advance(dt)` — целое число фиксированных шагов, ограниченное catch-up;
 *   3. на КАЖДЫЙ шаг: `signal.update(step)` → `simulation.step(step)` — светофоры
 *      живут даже без транспорта, транспорт читает уже обновлённые аспекты;
 *   4. `layer.update(dt, view)` — интерполяция между шагами и отрисовка.
 *
 * Состояние светофоров принадлежит контроллеру и НЕ сбрасывается при выгрузке
 * chunks/моделей: узел, снова попавший в область камеры, продолжает ту же фазу
 * и сохраняет занятость конфликтных зон. Смена release (новые данные) сбрасывает
 * только контроллеры этого релиза — это явная переинициализация данных.
 */

import * as THREE from 'three';
import { DEFAULT_MAX_CATCH_UP_STEPS, DEFAULT_STEP_HZ, DEFAULT_TIME_ZONE, SimulationClock } from '../../mobility/clock';
import { SignalController } from '../../mobility/signals';
import { TripSimulation } from '../../mobility/simulation';
import type {
  MobilityAspect,
  MobilityDebugDump,
  MobilityEdge,
  MobilityRouteFile,
  MobilityRouteIndexEntry,
  MobilityScheduleStatus,
  MobilitySettings,
  MobilitySignalNode,
  MobilityStatus,
} from '../../shared/mobility';
import { MobilityLoader, type MobilityFetchImpl } from './loader';
import { MobilityLayer } from './mobilityLayer';
import { mobilityReleaseKey, mobilityReleaseLabel, type MobilityLoadRect } from './loaderCore';

/** Видимая земля кадра в ЛОКАЛЬНЫХ метрах (x восток, y север). */
export interface MobilityControllerView {
  rect: MobilityLoadRect;
  /** Мировые метры на пиксель кадра — от него зависит экранный LOD. */
  worldPerPixel: number;
}

export interface MobilityControllerOptions {
  /** Каталог данных; по умолчанию `/data/mobility` (см. `MobilityLoader`). */
  baseUrl?: string;
  /** Мобильный бюджет (меньше единиц транспорта, без теней). */
  mobile?: boolean;
  /** Реализация fetch для тестов/QA. */
  fetchImpl?: MobilityFetchImpl;
  /** Ограничение одновременно симулируемых рейсов (аналитические не считаются). */
  maxTrips?: number;
  /** Стартовать симуляцию на паузе. */
  paused?: boolean;
}

const DEFAULT_SETTINGS: MobilitySettings = {
  vehiclesVisible: true,
  signalsVisible: true,
  debug: false,
  paused: false,
};

/** Сколько кадров хранить для p50 стоимости симуляции. */
const SIMULATION_WINDOW = 120;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? 0;
}

/** Объединение bbox `[minX, minY, maxX, maxY]`; `null` для пустого списка. */
function unionBounds(
  bounds: readonly (readonly number[])[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const entry of bounds) {
    if (!Array.isArray(entry) || entry.length !== 4) continue;
    const [x0, y0, x1, y1] = entry;
    if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) continue;
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Контроллер мобильности (транспорт + светофоры).
 *
 * Создаётся до загрузки manifest; `start()` асинхронный и не бросает исключений —
 * карта остаётся рабочей при недоступных данных. `update()` вызывается из
 * существующего кадра `createCityApp`, второго render loop нет.
 */
export class MobilityController {
  readonly root = new THREE.Group();
  readonly loader: MobilityLoader;
  readonly layer: MobilityLayer;

  private clock: SimulationClock | null = null;
  private simulation: TripSimulation | null = null;
  private readonly signalControllers = new Map<string, SignalController>();
  private signalEntries: { nodeId: string; x: number; y: number; controller: SignalController }[] = [];
  /**
   * Geometry index for the simulation. It ACCUMULATES edges from every chunk ever
   * loaded instead of dropping evicted ones: a trip outside the camera must keep
   * an exact lane path, and the corridors are small (~200 edges). It is cleared
   * only when the release identity changes (new data).
   */
  private readonly edgeIndex = new Map<string, MobilityEdge>();
  /** Имена остановок из загруженных chunks (`stopId` → имя) для карточки рейса. */
  private readonly stopNames = new Map<string, string>();
  private settings: MobilitySettings = { ...DEFAULT_SETTINGS };
  private releaseKeyValue: string | null = null;
  private scheduleStatus: MobilityScheduleStatus = 'absent';
  private extraNotes: string[] = [];
  private readonly simulationSamples: number[] = [];
  private lastDrawnIds = new Set<string>();
  /**
   * Bounds of all verified corridors. Every frame requests the union of this
   * rect and the camera rect, so the corridor geometry is always resident: the
   * simulation builds exact lane paths instead of the chord fallback, and the
   * camera cannot evict the corridor chunks out from under a trip. The shipped
   * corridors are ~1 MB in total, so this is a bounded cost.
   */
  private corridorRect: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private disposed = false;
  private startPromise: Promise<void> | null = null;
  private routesRequested = false;
  /** Городской режим: маршруты грузятся окном вокруг камеры, а не все сразу. */
  private cityMode = false;
  private lastRouteLoadAt = 0;
  /** Запас вокруг камеры для загрузки файлов маршрутов, метры. */
  private readonly routeLoadMarginM = 1200;
  private readonly options: MobilityControllerOptions;

  constructor(options: MobilityControllerOptions = {}) {
    this.options = options;
    this.root.name = 'mobility-controller';
    this.loader = new MobilityLoader({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      // Городской масштаб: сотни чанков и десятки файлов маршрутов вокруг
      // камеры. Данные мобильности для города — десятки мегабайт, поэтому
      // лимиты рассчитаны на окно вокруг камеры, а не на весь город сразу.
      maxChunks: 256,
      maxVariantFiles: 64,
      maxRouteBytes: 32 * 1024 * 1024,
      chunkMarginM: 600,
      onStateChange: () => undefined,
      onError: (message) => {
        this.note(`mobility: ${message}`, true);
      },
      onChunksChanged: () => {
        this.refreshEdgeIndex();
        this.syncSignalControllers();
      },
    });
    this.layer = new MobilityLayer({
      mobile: options.mobile,
      signalSource: this.loader,
    });
    this.root.add(this.layer.root);
    if (options.paused) this.settings.paused = true;
  }

  /**
   * Загрузить manifest и подготовить симуляцию. Повторный вызов возвращает тот
   * же промис. Ошибки данных не бросаются наружу: состояние уходит в `error`,
   * карта продолжает работать.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    await this.loader.start();
    if (this.disposed) return;
    const manifest = this.loader.manifest;
    if (!manifest) {
      this.note('mobility payload unavailable: map keeps working without transport', true);
      return;
    }
    this.releaseKeyValue = mobilityReleaseKey(manifest.release);
    this.scheduleStatus = manifest.scheduleStatus;
    if (manifest.scheduleStatus === 'synthetic') {
      this.note(
        'Демонстрационное расписание: это не публичное расписание Минсктранса, а модель для проверки движения',
        true,
      );
    } else if (manifest.scheduleStatus === 'unavailable' || manifest.scheduleStatus === 'absent') {
      this.note(
        `Публичное расписание недоступно: показываются только проверенная геометрия и светофоры${
          manifest.scheduleNote ? ` (${manifest.scheduleNote})` : ''
        }`,
        true,
      );
    }
    for (const note of this.loader.notesList.slice(0, 4)) this.note(note, false);

    const timeZone = manifest.calendars[0]?.timeZone ?? DEFAULT_TIME_ZONE;
    this.clock = new SimulationClock({
      stepHz: DEFAULT_STEP_HZ,
      maxCatchUpSteps: DEFAULT_MAX_CATCH_UP_STEPS,
      timeZone,
      paused: this.settings.paused,
    });
    this.simulation = new TripSimulation({
      clock: this.clock,
      world: {
        getRouteFile: (variantId: string): MobilityRouteFile | null => this.loader.getVariant(variantId),
        getEdge: (edgeId: string): MobilityEdge | null => this.edgeIndex.get(edgeId) ?? null,
        getManifest: () => this.loader.manifest,
        getVariants: (): readonly MobilityRouteIndexEntry[] =>
          (this.loader.manifest?.routes ?? []).filter((entry) => entry.verified),
        getSignalsNear: (x: number, y: number, radiusM: number) => {
          const radius = Math.max(0, radiusM);
          return this.signalEntries.filter((entry) => {
            const dx = entry.x - x;
            const dy = entry.y - y;
            return dx * dx + dy * dy <= radius * radius;
          });
        },
      },
      maxTrips: this.options.maxTrips ?? (this.options.mobile ? 12 : 32),
    });
    // All verified variants are small (two corridors): load them up front so the
    // simulation can place already-running trips instead of waiting for a camera
    // rectangle that may never contain the trip's current section.
    const verified = (manifest.routes ?? []).filter((entry) => entry.verified);
    // Городской релиз: сотни маршрутов. Грузим только окно вокруг камеры,
    // иначе старт тянет весь город.
    this.cityMode = verified.length > 40;
    const verifiedIds = verified.map((entry) => entry.id);
    if (!this.cityMode && verifiedIds.length > 0) {
      this.routesRequested = true;
      await this.loader.ensureRoutes(verifiedIds);
      // Remember the corridor extent; `update()` always requests at least this
      // rectangle so exact lane geometry is resident regardless of the camera.
      this.corridorRect = unionBounds(verified.map((entry) => entry.bounds));
    }
    this.syncSignalControllers();
    this.refreshEdgeIndex();
    this.simulation.reinitialize();
  }

  /** Применить переключатели UI. Скрытие не останавливает правила. */
  setSettings(partial: Partial<MobilitySettings>): void {
    const next: MobilitySettings = { ...this.settings, ...partial };
    if (next.paused !== this.settings.paused) {
      this.clock?.setPaused(next.paused);
    }
    this.settings = next;
    this.layer.setSettings(next);
  }

  getSettings(): MobilitySettings {
    return { ...this.settings };
  }

  /**
   * Явная переинициализация сервисной даты и времени суток (QA). `null` —
   * вернуться к живым часам. По умолчанию 08:00 местного времени зоны
   * расписания: в это время на проверенных коридорах гарантированно есть
   * активные рейсы. Смена даты/времени пересоздаёт план рейсов целиком
   * (`reinitialize`) — это явная операция, а не «телепорт» внутри прогона.
   */
  setServiceDate(date: string | null, secondsOfDay = 8 * 3600): void {
    if (!this.clock) return;
    if (date === null) this.clock.resetToNow();
    else this.clock.setFixedDateTime(date, secondsOfDay);
    this.simulation?.reinitialize();
  }

  /** Один кадр существующего render loop. */
  update(dt: number, view: MobilityControllerView): void {
    if (this.disposed) return;
    const rect = view.rect;
    // Camera rect ∪ corridor extent (see `corridorRect`). The corridor rect is
    // set asynchronously after the manifest arrives; until then the camera rect
    // alone drives loading.
    this.loader.update(
      this.corridorRect
        ? unionBounds([
            [rect.minX, rect.minY, rect.maxX, rect.maxY],
            [
              this.corridorRect.minX,
              this.corridorRect.minY,
              this.corridorRect.maxX,
              this.corridorRect.maxY,
            ],
          ]) ?? rect
        : rect,
    );
    if (!this.clock || !this.simulation) return;

    // Routes for the visible rectangle: a trip may enter the view whose variant
    // was never requested (the up-front load covers the shipped corridors; this
    // keeps the loader honest when more corridors are added later).
    if (this.cityMode) {
      // Городской режим: подгружаем маршруты окном вокруг камеры. Частота
      // ограничена, чтобы панорамирование не порождало запрос на каждый кадр.
      const now = nowMs();
      if (now - this.lastRouteLoadAt >= 1500) {
        this.lastRouteLoadAt = now;
        const margin = this.routeLoadMarginM;
        void this.loader.ensureRoutesForRect({
          minX: rect.minX - margin,
          minY: rect.minY - margin,
          maxX: rect.maxX + margin,
          maxY: rect.maxY + margin,
        });
      }
    } else if (!this.routesRequested) {
      this.routesRequested = true;
      void this.loader.ensureRoutesForRect(rect);
    }

    const steps = this.clock.advance(dt);
    if (steps > 0) {
      const started = nowMs();
      for (let step = 0; step < steps; step += 1) {
        const stepSeconds = this.clock.stepSeconds;
        for (const controller of this.signalControllers.values()) controller.update(stepSeconds);
        this.simulation.step(stepSeconds);
      }
      this.recordSimulationMs(nowMs() - started);
    }

    const trips = this.simulation.snapshots();
    this.layer.update(dt, {
      rect: {
        minX: rect.minX,
        maxX: rect.maxX,
        minZ: -rect.maxY,
        maxZ: -rect.minY,
      },
      time: this.clock.serviceSecondsExact,
      worldPerPixel: view.worldPerPixel,
      trips,
      signals: this.signalStates(),
      step: this.clock.stepCount,
    });
    // The layer decides what is actually drawn (LOD, budget, culling); record it
    // so the QA dump reports the same set the screen shows.
    const drawnTripIds = this.layer.getStats().drawnTripIds;
    this.lastDrawnIds = new Set(drawnTripIds);
    for (const trip of trips) trip.drawn = this.lastDrawnIds.has(trip.tripId);
  }

  /** Полный детерминированный снимок для QA/тестов. */
  getDump(): MobilityDebugDump | null {
    if (!this.clock || !this.simulation) return null;
    const controllers = [...this.signalControllers.values()];
    return {
      clock: {
        serviceDate: this.clock.serviceDate,
        serviceSeconds: this.clock.serviceSecondsExact,
        stepHz: this.clock.stepHz,
        paused: this.clock.paused,
      },
      settings: this.getSettings(),
      status: this.getStatus(),
      trips: [...this.simulation.snapshots()].map((trip) => ({
        ...trip,
        drawn: this.lastDrawnIds.has(trip.tripId),
      })),
      signals: controllers.map((controller) => {
        const snapshot = controller.snapshot();
        const entry = this.signalEntries.find((candidate) => candidate.nodeId === snapshot.nodeId);
        return {
          nodeId: snapshot.nodeId,
          x: entry?.x ?? 0,
          y: entry?.y ?? 0,
          aspects: snapshot.aspects,
          phase: snapshot.phase,
          occupied: snapshot.occupied,
        };
      }),
    };
  }

  /** Статус для панели и статистики; дешёвый, вызывается по опросу UI. */
  getStatus(): MobilityStatus {
    const loaderStats = this.loader.getStats();
    const simulationStats = this.simulation?.getStats();
    const layerStats = this.layer.getStats();
    const manifest = this.loader.manifest;
    // Notes are the honest channel for "geometry not loaded yet", fallback
    // calendars and unavailable schedule; the UI shows the first one.
    const notes: string[] = [];
    const approximatedVariants = simulationStats?.approximatedVariants ?? 0;
    const simulationNotes = (this.simulation?.getNotes() ?? []).filter(
      (note) =>
        // Once every variant has exact lane geometry, the earlier "fallback
        // until geometry loads" note is history, not current state.
        !(approximatedVariants === 0 && note.includes('fallback до загрузки геометрии')),
    );
    for (const source of [this.extraNotes, simulationNotes, this.loader.notesList]) {
      for (const note of source) {
        if (note && !notes.includes(note)) notes.push(note);
      }
    }
    return {
      state: this.resolveState(),
      scheduleStatus: this.scheduleStatus,
      serviceDate: this.clock?.serviceDate ?? '',
      serviceSeconds: this.clock?.serviceSeconds ?? 0,
      fixedDate: this.clock?.fixedDate ?? null,
      release: manifest ? mobilityReleaseLabel(manifest.release, manifest.generatedAt) : '',
      notes: notes.slice(0, 8),
      activeVariants: manifest?.counts.verifiedVariants ?? 0,
      scheduledTrips: simulationStats?.scheduledToday ?? 0,
      activeTrips: simulationStats?.activeTrips ?? 0,
      drawnTrips: layerStats.drawnTrips,
      blockedTrips: simulationStats?.blockedTrips ?? 0,
      loadedChunks: loaderStats.loadedChunks,
      loadedBytes: loaderStats.loadedBytes + loaderStats.routeBytes,
      signalNodes: layerStats.signalNodes,
      signalNodesDrawn: layerStats.signalNodesDrawn,
      simulationMs: this.simulationMs(),
      templateBytes: layerStats.templateBytes,
      instanceBytes: layerStats.instanceBytes,
    };
  }

  /** Подсветить выбранный рейс (цвет кузова + метка); `null` — снять. */
  setSelectedTrip(tripId: string | null): void {
    this.layer.setSelectedTrip(tripId);
  }

  /** Отпечаток release для проверки смешивания данных в QA. */
  getReleaseKey(): string | null {
    return this.releaseKeyValue;
  }

  /**
   * Данные для карточки выбранного транспорта: маршрут, направление, следующая
   * остановка, задержка. `null`, если рейс уже не активен.
   */
  describeTrip(tripId: string): {
    tripId: string;
    ref: string;
    mode: 'bus' | 'trolleybus' | 'tram';
    headSign: string;
    nextStopName: string;
    delayS: number;
    speed: number;
    phase: string;
  } | null {
    if (!this.simulation) return null;
    const snapshot = this.simulation.snapshots().find((trip) => trip.tripId === tripId);
    if (!snapshot) return null;
    const variant = this.loader.getVariant(snapshot.variantId)?.variant ?? null;
    const nextCall =
      variant && snapshot.nextStop >= 0 ? variant.stops[snapshot.nextStop] ?? null : null;
    return {
      tripId: snapshot.tripId,
      ref: snapshot.ref,
      mode: snapshot.mode,
      headSign: variant?.headSign ?? '',
      nextStopName: nextCall ? this.stopNames.get(nextCall.stopId) ?? '' : '',
      delayS: snapshot.delayS,
      speed: snapshot.speed,
      phase: snapshot.phase,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signalControllers.clear();
    this.signalEntries = [];
    this.simulation?.dispose();
    this.simulation = null;
    this.clock = null;
    this.layer.dispose();
    this.loader.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }

  // --- внутреннее ---------------------------------------------------------

  private resolveState(): MobilityStatus['state'] {
    if (this.loader.error) return 'error';
    const loaderState = this.loader.state;
    if (loaderState === 'error' || loaderState === 'unavailable') return 'error';
    if (!this.loader.manifest) return loaderState === 'loading' ? 'loading' : 'idle';
    if (this.scheduleStatus === 'synthetic') return 'partial';
    if (this.scheduleStatus === 'unavailable' || this.scheduleStatus === 'absent') return 'unavailable';
    if (this.scheduleStatus === 'partial') return 'partial';
    return this.loader.getStats().loadedChunks > 0 ? 'ready' : 'loading';
  }

  /** Создать контроллеры для новых узлов; старые фазы не сбрасываются. */
  private syncSignalControllers(): void {    const manifest = this.loader.manifest;
    if (!manifest) return;
    const releaseKey = mobilityReleaseKey(manifest.release);
    if (this.releaseKeyValue !== null && this.releaseKeyValue !== releaseKey) {
      // Новый релиз данных: старая занятость/фазы к нему не относятся.
      this.signalControllers.clear();
      this.signalEntries = [];
      this.releaseKeyValue = releaseKey;
    }
    let added = 0;
    for (const node of this.loader.getSignalNodes()) {
      if (this.signalControllers.has(node.id)) continue;
      try {
        const controller = new SignalController(node);
        this.signalControllers.set(node.id, controller);
        added += 1;
      } catch (error) {
        this.note(`signal node ${node.id}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
    if (added > 0 || this.signalEntries.length !== this.signalControllers.size) this.rebuildSignalEntries();
  }

  /**
   * Собрать индекс рёбер из загруженных chunks. Рёбра из выгруженных chunks
   * остаются в индексе: рейс вне камеры должен сохранять точную полосу. Очистка
   * индекса — только при смене release (новые данные).
   */
  private refreshEdgeIndex(): void {
    const manifest = this.loader.manifest;
    const releaseKey = manifest ? mobilityReleaseKey(manifest.release) : null;
    if (
      this.releaseKeyValue !== null &&
      releaseKey !== null &&
      this.releaseKeyValue !== releaseKey
    ) {
      this.edgeIndex.clear();
      this.stopNames.clear();
    }
    for (const chunk of this.loader.getChunks()) {
      for (const edge of chunk.edges) {
        if (!this.edgeIndex.has(edge.id)) this.edgeIndex.set(edge.id, edge);
      }
      for (const stop of chunk.stops) {
        if (!this.stopNames.has(stop.id)) this.stopNames.set(stop.id, stop.name);
      }
    }
  }

  private rebuildSignalEntries(): void {
    const positions = new Map<string, MobilitySignalNode>();
    for (const node of this.loader.getSignalNodes()) positions.set(node.id, node);
    const entries: { nodeId: string; x: number; y: number; controller: SignalController }[] = [];
    for (const [nodeId, controller] of this.signalControllers) {
      const node = positions.get(nodeId);
      if (!node) continue;
      entries.push({ nodeId, x: node.x, y: node.y, controller });
    }
    // Детерминированный порядок: от него зависят позиции инстансов и тесты.
    entries.sort((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0));
    this.signalEntries = entries;
  }

  private signalStates(): { nodeId: string; aspects: Readonly<Record<string, MobilityAspect>> }[] {
    return this.signalEntries.map((entry) => ({
      nodeId: entry.nodeId,
      aspects: entry.controller.aspects(),
    }));
  }

  private recordSimulationMs(milliseconds: number): void {
    this.simulationSamples.push(milliseconds);
    if (this.simulationSamples.length > SIMULATION_WINDOW) this.simulationSamples.shift();
  }

  private simulationMs(): number {
    if (this.simulationSamples.length === 0) return 0;
    const sorted = [...this.simulationSamples].sort((left, right) => left - right);
    return percentile(sorted, 0.5);
  }

  private note(message: string, surface: boolean): void {
    if (!message) return;
    if (surface) {
      if (!this.extraNotes.includes(message)) this.extraNotes.push(message);
      if (this.extraNotes.length > 8) this.extraNotes.shift();
    }
  }
}
