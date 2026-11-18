/**
 * Isometric Minsk — оркестрация рейсов общественного транспорта.
 *
 * Модуль связывает три части, оставаясь чистым (без Three.js, React и таймеров):
 *   - часы (`SimulationClock`) — единственный источник модельного времени;
 *   - расписание (`TripSchedule` / `tripPhaseAt`) — плановая фаза, календари,
 *     рейсы после полуночи и перенос задержки;
 *   - светофоры (`SignalController`) — аспекты, стоп-линии и занятость узлов.
 *
 * Границы ответственности:
 *   - фазы светофоров продвигает ВНЕШНИЙ код (движок/`MobilityController`) на
 *     каждом шаге, чтобы светофоры работали и без транспорта; симуляция только
 *     читает `canEnter()`/`stopLine()`/`isOccupied()` и сообщает о физическом
 *     присутствии через `enter()`/`updatePosition()`/`exit()`, а о занятом
 *     выходе — через `setExitBlocked()`. `controller.update()` здесь НЕ
 *     вызывается;
 *   - расписание не даёт права проехать красный: перед стоп-линией решает
 *     `canEnter()`, включая жёлтый (`decideYellowStop` внутри `signals.ts`);
 *   - путь рейса — конкатенация полос рёбер варианта (`TripWorld.getEdge`),
 *     остановки привязаны по паре (edgeId, s); если геометрия рёбер ещё не
 *     загружена, включается явный fallback по остановкам (`exact=false`) с
 *     записью причины в `getNotes()` и счётчиком `approximatedVariants`.
 *
 * Режимы рейсов:
 *   - активные (modelled) — до `maxTrips` штук, с физикой, очередью и
 *     светофорами; порядок выбора детерминированный (дата, затем id рейса);
 *   - аналитические — та же плановая фаза плюс накопленная задержка, без
 *     светофоров; используются, когда рейс не влез в бюджет или его файл
 *     варианта выгружен. Задержка при этом НЕ сбрасывается.
 *
 * Данные, которых нет, не выдумываются:
 *   - нет файла варианта — рейс живёт аналитически по плановой фазе;
 *   - нет календарей через `TripWorld.getManifest()` — явный ежедневный режим с
 *     дедупликацией одинаковых рейсов разных календарей и записью причины в
 *     `getNotes()` (никаких вымышленных интервалов).
 */

import { mobilityPolylineLength } from '../shared/mobility';
import type {
  MobilityAspect,
  MobilityEdge,
  MobilityManifest,
  MobilityMode,
  MobilityRouteFile,
  MobilityRouteIndexEntry,
  MobilityServiceCalendar,
  MobilityStopLine,
  MobilityStopTime,
  MobilitySyntheticTimetable,
  MobilityTrip,
  MobilityTripSnapshot,
} from '../shared/mobility';
import type { SimulationClock } from './clock';
import {
  SECONDS_PER_DAY,
  TripSchedule,
  addIsoDays,
  isoDateToDayNumber,
  tripPhaseAt,
  type ActiveScheduledTrip,
} from './schedule';
import { DEFAULT_EXIT_MARGIN_M } from './signals';
import {
  advanceMotion,
  buildRoutePathFromFile,
  motionProfileForMode,
  sampleRoutePath,
  schedulePaceSpeed,
  type MotionProfile,
  type RoutePath,
  type RoutePathSample,
} from './vehicleMotion';

/** Максимум одновременно смоделированных рейсов по умолчанию. */
export const DEFAULT_MAX_TRIPS = 32;

/** Радиус поиска загруженных светофоров вокруг машины, метры. */
export const DEFAULT_MAX_SIGNAL_RADIUS_M = 150;

/** Допуск времени, секунды (float-устойчивость). */
const TIME_EPSILON_S = 1e-6;

/** Допуск времени при реконструкции шага, секунды. */
const SECONDS_EPSILON = 1e-9;

/** Допуск прибытия на остановку, метры. */
const ARRIVAL_EPSILON_M = 0.05;

/** Порог «рейс задержан», секунды (для статистики). */
const DELAY_EPSILON_S = 0.5;

/** Сколько секунд держать завершённый рейс в снимке перед удалением. */
const FINISHED_LINGER_S = 2;

/**
 * Максимальный боковой разброс проекции стоп-линии на путь, метры.
 * У точного пути полос это единицы метров; запас нужен для fallback по
 * остановкам, где на повороте хорда может отстоять от узла.
 */
const MAX_SIGNAL_LATERAL_M = 60;

const EMPTY_SNAPSHOTS: readonly MobilityTripSnapshot[] = Object.freeze([]);

/** Стабильный 32-битный хеш строки (FNV-1a) — фаза рейсов внутри интервала. */
function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
const EMPTY_NOTES: readonly string[] = Object.freeze([]);

/** Публичный интерфейс мира, который даёт движок. */
export interface TripWorld {
  /** Загруженный файл варианта (вариант + рейсы) или `null`, если не загружен. */
  getRouteFile(variantId: string): MobilityRouteFile | null;
  /** Индекс всех вариантов (в порядке manifest). */
  getVariants(): readonly MobilityRouteIndexEntry[];
  /**
   * Геометрия ребра по его id. Индекс рёбер собирается из загруженных chunks и
   * не очищается при выгрузке chunk; `null` — геометрия ещё не загружена.
   */
  getEdge(edgeId: string): MobilityEdge | null;
  /** Загруженные светофоры в радиусе (x, y — локальные метры). */
  getSignalsNear(
    x: number,
    y: number,
    radiusM: number,
  ): ReadonlyArray<{ nodeId: string; x: number; y: number; controller: import('./signals').SignalController }>;
  /**
   * Manifest с календарями обслуживания и статусом расписания. Без него
   * симуляция работает в явном ежедневном режиме (см. `getNotes()`).
   */
  getManifest?(): MobilityManifest | null;
}

/** Параметры симуляции рейсов. */
export interface TripSimulationOptions {
  clock: SimulationClock;
  world: TripWorld;
  /** Максимум одновременно смоделированных (не аналитических) рейсов. */
  maxTrips?: number;
  /** Радиус поиска светофоров, метры. */
  maxSignalRadiusM?: number;
}

/** Статистика симуляции; дополнительные поля — для QA/панели. */
export interface TripSimulationStats {
  activeTrips: number;
  blockedTrips: number;
  delayedTrips: number;
  scheduledToday: number;
  /** Сколько рейсов реально смоделировано в этом шаге. */
  modelledTrips: number;
  /** Сколько активных рейсов идут аналитически. */
  analyticTrips: number;
  /** Сколько вариантов используют документированный fallback по остановкам. */
  approximatedVariants: number;
  /** Откуда взяты календари обслуживания. */
  calendarSource: 'manifest' | 'fallback';
}

interface RouteRecord {
  variantId: string;
  entry: MobilityRouteIndexEntry;
  file: MobilityRouteFile;
  path: RoutePath;
  trips: readonly MobilityTrip[];
  /** true — путь собран из полос рёбер; false — явный fallback по остановкам. */
  exact: boolean;
  /** Рёбра, которых не хватило для точного пути (для повторной попытки). */
  missingEdgeIds: readonly string[];
  /** Набор уже загруженных «недостающих» рёбер на момент последней пересборки. */
  refreshKey?: string;
}

/** Стоп-линия, спроецированная на путь рейса. */
interface SignalCrossing {
  nodeId: string;
  movementId: string;
  controller: import('./signals').SignalController;
  /** Дистанция пути, где передний габарит пересекает стоп-линию, м. */
  stopLineDistanceM: number;
  /** Длина пути манёвра (для отслеживания занятости), м. */
  pathLengthM: number;
  /** Габарит манёвра из payload, м. */
  clearanceLengthM: number;
  /** Боковой разброс проекции, м. */
  lateralM: number;
}

/** Активная занятость манёвра светофора. */
interface ActiveSignalEntry {
  nodeId: string;
  movementId: string;
  controller: import('./signals').SignalController;
  stopLineDistanceM: number;
  pathLengthM: number;
}

interface BlockedExitEntry {
  controller: import('./signals').SignalController;
  movementId: string;
}

/** Полностью смоделированный рейс. */
interface ActiveTrip {
  trip: MobilityTrip;
  variantId: string;
  route: RouteRecord;
  profile: MotionProfile;
  /** Дата обслуживания кадра рейса (может быть предыдущей для рейса после полуночи). */
  serviceDate: string;
  /** Индекс следующей остановки; -1 у завершённого рейса. */
  nextStop: number;
  distanceM: number;
  speedMps: number;
  delayS: number;
  atStop: boolean;
  holdUntilS: number | null;
  actualArrivalS: number | null;
  /** Минимальная стоянка, вычисленная при прибытии, секунды. */
  stopDwellS: number;
  finished: boolean;
  finishedAtS: number;
  phase: MobilityTripSnapshot['phase'];
  blockedReason: 'signal' | 'queue' | null;
  signal: ActiveSignalEntry | null;
  blockedExits: Map<string, BlockedExitEntry>;
  /** Зафиксированное решение на жёлтый для ближайшего узла. */
  yellowHold: { nodeId: string; movementId: string; stop: boolean } | null;
  /** Конфликтная зона, занятая при появлении рейса: ждём до освобождения. */
  zoneHold: { nodeId: string; movementId: string; controller: import('./signals').SignalController } | null;
}

interface LeaderInfo {
  tripId: string;
  distanceM: number;
  bodyLengthM: number;
}

interface AnalyticState {
  distanceM: number;
  speedMps: number;
  phase: MobilityTripSnapshot['phase'];
  nextStop: number;
}

interface StepContext {
  serviceDate: string;
  seconds: number;
}

function stopLineMidpoint(stopLine: MobilityStopLine, fallbackX: number, fallbackY: number): { x: number; y: number } {
  const values = stopLine?.line;
  if (Array.isArray(values) && values.length >= 6) {
    const [x0, y0, , x1, y1] = values;
    if (Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)) {
      return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    }
  }
  return { x: fallbackX, y: fallbackY };
}

/** Проекция точки на участок пути `[minS, maxS]`; `null`, если участка нет. */
function projectPointOntoPath(
  path: RoutePath,
  x: number,
  y: number,
  minS: number,
  maxS: number,
): { distanceM: number; lateralM: number } | null {
  const points = path.points;
  const arc = path.arc;
  if (points.length < 3 || arc.length === 0) return null;
  if (points.length === 3 || arc.length < 2) {
    const lateral = Math.hypot(x - points[0], y - points[1]);
    const distanceM = arc[0];
    if (distanceM < minS - TIME_EPSILON_S || distanceM > maxS + TIME_EPSILON_S) return null;
    return { distanceM, lateralM: Number.isFinite(lateral) ? lateral : Number.POSITIVE_INFINITY };
  }
  let best: { distanceM: number; lateralM: number } | null = null;
  for (let index = 0; index + 1 < arc.length; index += 1) {
    const segmentStart = arc[index];
    const segmentEnd = arc[index + 1];
    if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd)) continue;
    if (segmentEnd < minS || segmentStart > maxS) continue;
    const ax = points[index * 3];
    const ay = points[index * 3 + 1];
    const bx = points[index * 3 + 3];
    const by = points[index * 3 + 4];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const rawT = lengthSq > 1e-9 ? ((x - ax) * dx + (y - ay) * dy) / lengthSq : 0;
    const t = Math.min(1, Math.max(0, rawT));
    let distanceM = segmentStart + (segmentEnd - segmentStart) * t;
    let px = ax + dx * t;
    let py = ay + dy * t;
    const clamped = Math.min(Math.max(distanceM, minS), maxS);
    if (Math.abs(clamped - distanceM) > 1e-9) {
      const span = segmentEnd - segmentStart;
      const clampedT = span > 1e-9 ? (clamped - segmentStart) / span : 0;
      px = ax + dx * clampedT;
      py = ay + dy * clampedT;
      distanceM = clamped;
    }
    const lateralM = Math.hypot(x - px, y - py);
    if (!Number.isFinite(lateralM)) continue;
    if (
      best === null ||
      lateralM < best.lateralM - 1e-9 ||
      (Math.abs(lateralM - best.lateralM) <= 1e-9 && distanceM < best.distanceM)
    ) {
      best = { distanceM, lateralM };
    }
  }
  return best;
}

function tripRunKey(trip: MobilityTrip): string {
  const times = trip.stopTimes.map((time) => `${time.arrivalS}:${time.departureS}`).join(',');
  return `${trip.variantId}|${times}`;
}

function dedupeTrips(trips: readonly MobilityTrip[], onNote: (message: string) => void): MobilityTrip[] {
  const sorted = [...trips].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const seen = new Set<string>();
  const result: MobilityTrip[] = [];
  let removed = 0;
  for (const trip of sorted) {
    const key = tripRunKey(trip);
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    seen.add(key);
    result.push(trip);
  }
  if (removed > 0) {
    onNote(`дубли рейсов разных календарей свёрнуты: ${removed} (календари недоступны)`);
  }
  return result;
}

function syntheticCalendars(
  trips: readonly MobilityTrip[],
  timeZone: string,
): readonly MobilityServiceCalendar[] {
  const ids = new Set<string>();
  for (const trip of trips) {
    if (trip.calendarId) ids.add(trip.calendarId);
  }
  return [...ids].sort().map((id) => ({
    id,
    startDate: '1970-01-01',
    endDate: '2999-12-31',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    timeZone,
  }));
}

/**
 * Симуляция рейсов: состояние, шаг, снимки и статистика.
 *
 * Один `step(dt)` — один фиксированный шаг часов (`dt = clock.stepSeconds`).
 * Симуляция сама не дергает `requestAnimationFrame`/`Date.now`; при разных
 * render FPS и одинаковом фиксированном шаге состояние одинаково.
 */
export class TripSimulation {
  private readonly clock: SimulationClock;
  private readonly world: TripWorld;
  private readonly maxTrips: number;
  private readonly maxSignalRadiusM: number;

  private readonly routes = new Map<string, RouteRecord>();
  /** Модель процедурного расписания (городской демо-релиз); `null` — рейсы из файлов. */
  private syntheticModel: MobilitySyntheticTimetable | null = null;
  private readonly states = new Map<string, ActiveTrip>();
  private readonly delays = new Map<string, number>();
  private readonly profiles = new Map<MobilityMode, MotionProfile>();
  private readonly notes: string[] = [];
  private readonly sampleTarget: RoutePathSample = { x: 0, y: 0, h: 0, heading: 0 };

  private schedule: TripSchedule | null = null;
  private latestActive: ActiveScheduledTrip[] = [];
  private calendarSource: 'manifest' | 'fallback' = 'fallback';
  private scheduledToday = 0;
  private stepBase = 0;
  private appliedSteps = 0;
  private lastClockSteps = 0;
  private lastClockEpochMs = 0;
  private disposed = false;
  private stats: TripSimulationStats = {
    activeTrips: 0,
    blockedTrips: 0,
    delayedTrips: 0,
    scheduledToday: 0,
    modelledTrips: 0,
    analyticTrips: 0,
    approximatedVariants: 0,
    calendarSource: 'fallback',
  };

  constructor(options: TripSimulationOptions) {
    if (!options || !options.clock) throw new RangeError('TripSimulation: не переданы часы');
    if (!options.world) throw new RangeError('TripSimulation: не передан мир');
    this.clock = options.clock;
    this.world = options.world;
    const maxTrips = options.maxTrips ?? DEFAULT_MAX_TRIPS;
    if (!Number.isInteger(maxTrips) || maxTrips < 1) {
      throw new RangeError(`maxTrips должен быть целым ≥ 1, получено: ${maxTrips}`);
    }
    this.maxTrips = maxTrips;
    const radius = options.maxSignalRadiusM ?? DEFAULT_MAX_SIGNAL_RADIUS_M;
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new RangeError(`maxSignalRadiusM должен быть положительным, получено: ${radius}`);
    }
    this.maxSignalRadiusM = radius;
    this.stepBase = this.clock.stepCount;
    this.lastClockSteps = this.clock.stepCount;
    this.lastClockEpochMs = this.clock.epochMs;
    this.rebuildSchedule();
  }

  /** true после `dispose()`; дальше методы — безопасные no-op. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Замечания о данных/режиме (для панели/QA): не молчаливые допущения. */
  getNotes(): readonly string[] {
    return this.disposed ? EMPTY_NOTES : [...this.notes];
  }

  /**
   * Явная переинициализация при смене даты/данных: состояние рейсов и задержки
   * сбрасываются, файлы вариантов и расписание перечитываются из мира.
   */
  reinitialize(): void {
    if (this.disposed) return;
    this.releaseAllSignalState();
    this.states.clear();
    this.delays.clear();
    this.routes.clear();
    this.schedule = null;
    this.latestActive = [];
    this.notes.length = 0;
    this.calendarSource = 'fallback';
    this.stepBase = this.clock.stepCount;
    this.lastClockSteps = this.clock.stepCount;
    this.lastClockEpochMs = this.clock.epochMs;
    this.appliedSteps = 0;
    this.syncData();
    this.refreshActive(this.clock.serviceDate, this.clock.serviceSecondsExact);
    this.refreshStats();
  }

  /**
   * Один фиксированный шаг; `dt = clock.stepSeconds`.
   *
   * `dt` используется только для кинематики; модельное время берётся из часов.
   * Движок сначала продвигает часы и светофоры, затем вызывает `step()` на
   * каждый шаг — поэтому время шага восстанавливается из часов, даже если за
   * кадр выполнено несколько шагов.
   */
  step(dtSeconds: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0) {
      throw new RangeError(`Некорректный шаг симуляции: ${dtSeconds}`);
    }
    if (dtSeconds === 0) return;

    // Часы переинициализированы (смена даты QA / resetToNow): это новый прогон.
    // Сброс виден и по числу шагов, и по уходу мгновения назад (QA-дата).
    if (
      this.clock.stepCount < this.lastClockSteps ||
      this.clock.epochMs < this.lastClockEpochMs ||
      this.clock.stepCount < this.stepBase + this.appliedSteps
    ) {
      this.resetTimeline();
    }
    this.syncData();
    this.refreshGeometry();

    const stepIndex = this.stepBase + this.appliedSteps + 1;
    const { serviceDate, seconds } = this.resolveStepTime(stepIndex);
    this.refreshActive(serviceDate, seconds);
    this.promoteTrips();

    const leaders = this.buildLeaderIndex();
    const ordered = [...this.states.values()].sort((left, right) =>
      left.trip.id < right.trip.id ? -1 : left.trip.id > right.trip.id ? 1 : 0,
    );
    for (const state of ordered) {
      this.stepActiveTrip(state, dtSeconds, serviceDate, seconds, leaders);
    }

    // Завершённые рейсы держим в снимках недолго: рендер успевает их убрать.
    for (const [tripId, state] of [...this.states]) {
      if (!state.finished) continue;
      const now = this.stateNowSeconds(state, serviceDate, seconds);
      if (now - state.finishedAtS > FINISHED_LINGER_S) {
        this.detachState(state);
        this.states.delete(tripId);
      }
    }

    this.appliedSteps += 1;
    this.lastClockSteps = this.clock.stepCount;
    this.lastClockEpochMs = this.clock.epochMs;
    this.refreshStats();
  }

  /** Новый массив снимков на каждый вызов; `drawn` выставляет рендер-слой. */
  snapshots(): readonly MobilityTripSnapshot[] {
    if (this.disposed) return EMPTY_SNAPSHOTS;
    const result: MobilityTripSnapshot[] = [];
    for (const state of this.states.values()) {
      result.push(this.snapshotForState(state));
    }
    for (const frame of this.latestActive) {
      if (this.states.has(frame.trip.id)) continue;
      const record = this.routes.get(frame.trip.variantId);
      if (!record) continue;
      result.push(this.snapshotForAnalytic(frame, record));
    }
    result.sort((left, right) =>
      left.tripId < right.tripId ? -1 : left.tripId > right.tripId ? 1 : 0,
    );
    return result;
  }

  /** Статистика для панели/QA. */
  getStats(): TripSimulationStats {
    return { ...this.stats };
  }

  /** tripId → накопленная задержка, секунды (для QA). */
  getDelays(): Readonly<Record<string, number>> {
    if (this.disposed) return Object.freeze({});
    const result: Record<string, number> = {};
    // Задержка переживает выгрузку файла варианта: это компактное состояние
    // рейса до возвращения камеры, и сбрасывать его нельзя.
    for (const [tripId, delay] of this.delays) result[tripId] = delay;
    for (const state of this.states.values()) {
      result[state.trip.id] = state.delayS;
    }
    for (const frame of this.latestActive) {
      if (result[frame.trip.id] !== undefined) continue;
      result[frame.trip.id] = 0;
    }
    return result;
  }

  /** Освобождает занятость светофоров и забывает состояние. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAllSignalState();
    for (const state of this.states.values()) {
      state.signal = null;
      state.blockedExits.clear();
    }
    this.states.clear();
    this.delays.clear();
    this.routes.clear();
    this.schedule = null;
    this.latestActive = [];
    this.notes.length = 0;
    this.stats = {
      activeTrips: 0,
      blockedTrips: 0,
      delayedTrips: 0,
      scheduledToday: 0,
      modelledTrips: 0,
      analyticTrips: 0,
      approximatedVariants: 0,
      calendarSource: 'fallback',
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Часы и хранимые данные.                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * Реконструкция времени шага.
   *
   * `clock.serviceSecondsExact`/`serviceDate` отражают время ПОСЛЕ всех
   * догоняющих шагов кадра, а движок затем вызывает `step()` на каждый шаг.
   * Поэтому время шага равно концу минус `(clock.stepCount - index)` шагов;
   * переход через полночь обрабатывается сдвигом даты (часовой пояс не
   * дублируется — дата считается через календарь расписания).
   */
  private resolveStepTime(index: number): StepContext {
    const clock = this.clock;
    const delta = clock.stepCount - index;
    let seconds = clock.serviceSecondsExact - delta * clock.stepSeconds;
    let serviceDate = clock.serviceDate;
    while (seconds < -SECONDS_EPSILON) {
      seconds += SECONDS_PER_DAY;
      serviceDate = addIsoDays(serviceDate, -1);
    }
    let guard = 0;
    while (seconds >= SECONDS_PER_DAY && guard < 4) {
      seconds -= SECONDS_PER_DAY;
      serviceDate = addIsoDays(serviceDate, 1);
      guard += 1;
    }
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    if (seconds >= SECONDS_PER_DAY) seconds = SECONDS_PER_DAY - SECONDS_EPSILON;
    return { serviceDate, seconds };
  }

  /** Секунды модельного времени шага для конкретного рейса (с учётом его даты). */
  private stateNowSeconds(state: ActiveTrip, serviceDate: string, seconds: number): number {
    const offsetDays =
      isoDateToDayNumber(serviceDate) - isoDateToDayNumber(state.serviceDate);
    return seconds + offsetDays * SECONDS_PER_DAY;
  }

  private resetTimeline(): void {
    this.releaseAllSignalState();
    this.states.clear();
    this.delays.clear();
    this.latestActive = [];
    this.appliedSteps = 0;
    this.stepBase = this.clock.stepCount;
  }

  private resolveManifest(): MobilityManifest | null {
    try {
      return this.world.getManifest?.() ?? null;
    } catch {
      return null;
    }
  }

  /** Источник геометрии рёбер; чужие исключения не пробрасываются. */
  private edgeGeometry(edgeId: string): MobilityEdge | null {
    try {
      return this.world.getEdge(edgeId) ?? null;
    } catch {
      return null;
    }
  }

  /** Считывает загруженные файлы вариантов; при изменении набора — пересобирает расписание. */
  private syncData(): void {
    let changed = false;
    const seen = new Set<string>();
    const manifest = this.resolveManifest();
    const syntheticModel =
      manifest && manifest.timetableMode === 'procedural'
        ? manifest.syntheticTimetable ?? null
        : null;
    this.syntheticModel = syntheticModel;
    let entries: readonly MobilityRouteIndexEntry[] = [];
    try {
      entries = this.world.getVariants();
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue;
      seen.add(entry.id);
      let file: MobilityRouteFile | null = null;
      try {
        file = this.world.getRouteFile(entry.id);
      } catch {
        file = null;
      }
      const cached = this.routes.get(entry.id);
      if (file) {
        if (cached && cached.file === file) {
          cached.entry = entry;
          continue;
        }
        const result = buildRoutePathFromFile(file, (edgeId) => this.edgeGeometry(edgeId));
        if (!result) {
          if (cached) {
            this.routes.delete(entry.id);
            changed = true;
          }
          this.pushNote(`вариант ${entry.id}: путь не построен (нет остановок/координат) — рейсы не моделируются`);
          continue;
        }
        const storedTrips = Array.isArray(file.trips) ? file.trips : [];
        // Городской демонстрационный релиз не хранит десятки тысяч рейсов: они
        // синтезируются по модели (маршрут, интервал, скорость, стоянка).
        const trips =
          storedTrips.length > 0
            ? storedTrips
            : syntheticModel
              ? this.synthesizeTrips(entry, result.path, syntheticModel)
              : [];
        this.routes.set(entry.id, {
          variantId: entry.id,
          entry,
          file,
          path: result.path,
          trips,
          exact: result.exact,
          missingEdgeIds: result.missingEdgeIds,
        });
        this.notePathMode(entry.id, result.exact, result.missingEdgeIds, result.reason);
        changed = true;
      } else if (cached) {
        this.routes.delete(entry.id);
        changed = true;
      }
    }
    for (const variantId of [...this.routes.keys()]) {
      if (seen.has(variantId)) continue;
      this.routes.delete(variantId);
      changed = true;
    }
    if (changed) this.rebuildSchedule();
  }

  /**
   * Синтезировать рейсы варианта по модели (городской демо-режим).
   *
   * Времена остановок распределяются по фактическим дистанциям построенного
   * пути, стоянка — модельная. Фаза внутри интервала детерминирована по id
   * варианта, поэтому картина не «дрожит» между перезагрузками.
   */
  private synthesizeTrips(
    entry: MobilityRouteIndexEntry,
    path: RoutePath,
    model: MobilitySyntheticTimetable,
  ): MobilityTrip[] {
    const mode = entry.mode;
    const headway = model.headwayS[mode] ?? 900;
    const cruise = model.cruiseMps[mode] ?? 7;
    const dwell = model.dwellS[mode] ?? 15;
    const distances = path.stopDistancesM;
    if (!(headway > 0) || !(cruise > 0) || distances.length < 2) return [];
    const phase = stableHash(`${entry.id}|${model.id}`) % Math.max(1, Math.round(headway));
    const trips: MobilityTrip[] = [];
    let departure = model.firstDepartureS + phase;
    while (departure <= model.lastDepartureS) {
      const stopTimes: MobilityStopTime[] = [];
      let clock = departure;
      for (let index = 0; index < distances.length; index += 1) {
        if (index > 0) {
          const segment = Math.max(0, distances[index] - distances[index - 1]);
          clock += segment / cruise;
        }
        const arrival = Math.round(clock);
        const isLast = index === distances.length - 1;
        const departureTime = arrival + (isLast ? 0 : Math.round(dwell));
        stopTimes.push({ seq: index, arrivalS: arrival, departureS: departureTime });
        clock = departureTime;
      }
      trips.push({
        id: `demo:${entry.id}:${Math.round(departure)}`,
        variantId: entry.id,
        calendarId: model.calendarId,
        stopTimes,
        complete: false,
      });
      // Интервал зависит от времени суток: ночью реже, но «мёртвых» часов нет.
      departure += this.headwayAt(mode, departure, model);
    }
    return trips;
  }

  /** Интервал отправления для момента суток (день/ночь, с переходом через полночь). */
  private headwayAt(
    mode: MobilityMode,
    serviceSeconds: number,
    model: MobilitySyntheticTimetable,
  ): number {
    const day = model.headwayS[mode] ?? 900;
    const night = model.nightHeadwayS?.[mode] ?? day;
    const start = model.nightStartS ?? 23 * 3600;
    const end = model.nightEndS ?? 5 * 3600 + 30 * 60;
    const seconds = ((serviceSeconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
    const inNight =
      start <= end ? seconds >= start && seconds < end : seconds >= start || seconds < end;
    return Math.max(60, inNight ? night : day);
  }

  /**
   * Повторная попытка собрать точный путь, когда геометрия рёбер догрузилась.
   *
   * Пересобираем путь при появлении ЛЮБОГО ранее отсутствовавшего ребра, а не
   * только когда загрузились все: длинный маршрут выходит за окно загрузки, и
   * раньше вариант навсегда оставался на хордах остановок — видимый автобус
   * ехал по прямой через дворы. Частичный путь оставляет точные участки
   * полосами, а отсутствующие далёкие рёбра перекрывает короткими мостами.
   *
   * Уже смоделированные рейсы варианта переводятся в аналитические: дистанции
   * старого (хордового) и нового пути — в разных системах координат, поэтому
   * скачок не маскируется, а кузов встаёт на реальную полосу.
   */
  private refreshGeometry(): void {
    for (const [variantId, record] of [...this.routes]) {
      if (record.missingEdgeIds.length === 0) continue;
      const loaded = record.missingEdgeIds.filter((edgeId) => this.edgeGeometry(edgeId));
      if (loaded.length === 0) continue;
      const refreshKey = loaded.join('|');
      if (record.refreshKey === refreshKey) continue;
      const result = buildRoutePathFromFile(record.file, (edgeId) => this.edgeGeometry(edgeId));
      if (!result) continue;
      this.routes.set(variantId, {
        ...record,
        path: result.path,
        exact: result.exact,
        missingEdgeIds: result.missingEdgeIds,
        refreshKey,
      });
      this.notePathMode(variantId, result.exact, result.missingEdgeIds, result.reason);
      for (const [tripId, state] of [...this.states]) {
        if (state.variantId !== variantId) continue;
        this.detachState(state);
        this.states.delete(tripId);
      }
      if (result.exact) {
        this.pushNote(`вариант ${variantId}: геометрия полос загружена — путь точный`);
      } else {
        this.pushNote(
          `вариант ${variantId}: догружено ${loaded.length} рёбер — путь уточнён (осталось ${result.missingEdgeIds.length})`,
        );
      }
    }
  }

  private notePathMode(
    variantId: string,
    exact: boolean,
    missingEdgeIds: readonly string[],
    reason: string | null,
  ): void {
    if (exact) return;
    const missing = missingEdgeIds.length > 0 ? ` (нет рёбер: ${missingEdgeIds.length})` : '';
    this.pushNote(
      `вариант ${variantId}: путь по остановкам — fallback до загрузки геометрии${missing}${reason ? `: ${reason}` : ''}`,
    );
  }

  /** Пересобирает индекс рейсов и календарей из загруженных вариантов. */
  private rebuildSchedule(): void {
    const routeIds = [...this.routes.keys()].sort();
    const allTrips: MobilityTrip[] = [];
    for (const variantId of routeIds) {
      const record = this.routes.get(variantId);
      if (!record) continue;
      for (const trip of record.trips) {
        if (!trip || typeof trip.id !== 'string' || trip.id.length === 0) continue;
        if (!Array.isArray(trip.stopTimes) || trip.stopTimes.length === 0) {
          this.pushNote(`рейс ${trip.id}: нет времён остановок — рейс исключён`);
          continue;
        }
        if (trip.stopTimes.length !== record.path.stopDistancesM.length) {
          this.pushNote(
            `рейс ${trip.id}: ${trip.stopTimes.length} времён на ${record.path.stopDistancesM.length} остановок пути — рейс исключён`,
          );
          continue;
        }
        allTrips.push(trip);
      }
    }

    const manifest = this.resolveManifest();
    let trips = allTrips;
    let calendars: readonly MobilityServiceCalendar[] = [];
    if (manifest && Array.isArray(manifest.calendars) && manifest.calendars.length > 0) {
      calendars = manifest.calendars;
      this.calendarSource = 'manifest';
    } else {
      this.calendarSource = 'fallback';
      this.pushNote(
        'календари обслуживания недоступны через TripWorld: ежедневный режим, одинаковые рейсы разных календарей свёрнуты',
      );
      trips = dedupeTrips(allTrips, (message) => this.pushNote(message));
      calendars = syntheticCalendars(trips, this.clock.timeZone);
    }

    const schedule = new TripSchedule({ trips, calendars });
    this.schedule = schedule;
    for (const issue of schedule.issues.slice(0, 4)) {
      this.pushNote(`расписание: ${issue.message}`);
    }
    const byId = new Map<string, MobilityTrip>();
    for (const trip of trips) byId.set(trip.id, trip);

    // Сохраняем уже смоделированные рейсы, если их данные всё ещё валидны.
    for (const [tripId, state] of [...this.states]) {
      const trip = byId.get(tripId);
      const record = this.routes.get(state.variantId);
      if (!trip || !record) {
        this.detachState(state);
        this.states.delete(tripId);
        continue;
      }
      state.trip = trip;
      state.route = record;
      state.profile = this.profileFor(record.path.mode);
    }
    this.latestActive = [];
    this.refreshStats();
  }

  private profileFor(mode: MobilityMode): MotionProfile {
    const cached = this.profiles.get(mode);
    if (cached) return cached;
    const profile = motionProfileForMode(mode);
    this.profiles.set(mode, profile);
    return profile;
  }

  private pushNote(message: string): void {
    if (!message || this.notes.includes(message)) return;
    this.notes.push(message);
    if (this.notes.length > 10) this.notes.splice(0, this.notes.length - 10);
  }

  /* ----------------------------------------------------------------------- */
  /* Активные рейсы.                                                         */
  /* ----------------------------------------------------------------------- */

  private refreshActive(serviceDate: string, seconds: number): void {
    const safeSeconds = Math.min(Math.max(seconds, 0), SECONDS_PER_DAY - SECONDS_EPSILON);
    if (!this.schedule) {
      this.latestActive = [];
      this.scheduledToday = 0;
      return;
    }
    try {
      this.latestActive = this.schedule.activeTrips(serviceDate, safeSeconds);
      this.scheduledToday = this.schedule.scheduledTrips(serviceDate).length;
    } catch {
      this.latestActive = [];
      this.scheduledToday = 0;
    }
    for (const frame of this.latestActive) {
      if (!this.delays.has(frame.trip.id)) this.delays.set(frame.trip.id, 0);
    }
  }

  private promoteTrips(): void {
    if (!this.schedule) return;
    for (const frame of this.latestActive) {
      if (this.states.size >= this.maxTrips) break;
      if (this.states.has(frame.trip.id)) continue;
      const record = this.routes.get(frame.trip.variantId);
      if (!record) continue;
      const state = this.createTripState(frame, record);
      if (!state) continue;
      this.states.set(state.trip.id, state);
      this.delays.set(state.trip.id, state.delayS);
    }
  }

  private createTripState(frame: ActiveScheduledTrip, record: RouteRecord): ActiveTrip | null {
    const trip = frame.trip;
    const path = record.path;
    if (!trip || !Number.isInteger(trip.stopTimes.length) || trip.stopTimes.length !== path.stopDistancesM.length) {
      return null;
    }
    const profile = this.profileFor(path.mode);
    const delay = this.delays.get(trip.id) ?? 0;
    const virtual = frame.serviceSeconds - delay;
    let phase;
    try {
      phase = tripPhaseAt(trip, virtual);
    } catch {
      return null;
    }
    const state: ActiveTrip = {
      trip,
      variantId: trip.variantId,
      route: record,
      profile,
      serviceDate: frame.serviceDate,
      nextStop: 0,
      distanceM: 0,
      speedMps: 0,
      delayS: delay,
      atStop: false,
      holdUntilS: null,
      actualArrivalS: null,
      stopDwellS: 0,
      finished: false,
      finishedAtS: 0,
      phase: 'moving',
      blockedReason: null,
      signal: null,
      blockedExits: new Map(),
      yellowHold: null,
      zoneHold: null,
    };
    const stopTimes = trip.stopTimes;
    switch (phase.kind) {
      case 'at-stop': {
        const stopIndex = phase.stopIndex;
        const stopDistance = path.stopDistancesM[stopIndex] ?? 0;
        state.nextStop = stopIndex;
        state.distanceM = stopDistance;
        state.atStop = true;
        state.actualArrivalS = (stopTimes[stopIndex]?.arrivalS ?? virtual) + delay;
        state.holdUntilS = (stopTimes[stopIndex]?.departureS ?? virtual) + delay;
        state.stopDwellS = Math.max(0, state.holdUntilS - state.actualArrivalS);
        state.phase = 'dwelling';
        break;
      }
      case 'between-stops': {
        const from = phase.fromIndex;
        const to = phase.toIndex;
        const startS = path.stopDistancesM[from] ?? 0;
        const endS = path.stopDistancesM[to] ?? startS;
        state.nextStop = to;
        state.distanceM = startS + Math.max(0, Math.min(1, phase.progress)) * (endS - startS);
        state.speedMps = schedulePaceSpeed(
          endS - state.distanceM,
          phase.phaseEndS - virtual,
          profile.maxSpeedMps,
          profile.minCruiseMps,
        );
        state.phase = 'moving';
        break;
      }
      case 'before-start': {
        state.nextStop = 0;
        state.distanceM = path.stopDistancesM[0] ?? 0;
        state.atStop = true;
        state.actualArrivalS = (stopTimes[0]?.arrivalS ?? virtual) + delay;
        state.holdUntilS = (stopTimes[0]?.departureS ?? virtual) + delay;
        state.stopDwellS = Math.max(0, state.holdUntilS - state.actualArrivalS);
        state.phase = 'waiting';
        break;
      }
      default: {
        state.nextStop = -1;
        state.distanceM = path.stopDistancesM[path.stopDistancesM.length - 1] ?? 0;
        state.finished = true;
        state.finishedAtS = frame.serviceSeconds;
        state.phase = 'finished';
        break;
      }
    }
    this.resolveAdoption(state);
    return state;
  }

  /**
   * При появлении рейса в загруженной области согласовывает занятость узла:
   * внутрь уже занятой конфликтной зоны машина не «возникает» — она тормозит
   * перед стоп-линией; свободный узел, в котором она оказалась по расписанию,
   * регистрирует как реальную занятость.
   */
  private resolveAdoption(state: ActiveTrip): void {
    if (state.finished || state.atStop) return;
    const path = state.route.path;
    const trip = state.trip;
    const stopIndex = state.nextStop;
    if (stopIndex <= 0 || stopIndex >= trip.stopTimes.length) return;
    const halfLength = state.profile.bodyLengthM / 2;
    const legStart = path.stopDistancesM[stopIndex - 1] ?? 0;
    const legEnd = path.stopDistancesM[stopIndex] ?? path.lengthM;
    const edges = this.legEdgeIds(path, stopIndex - 1, stopIndex);
    if (edges.size === 0) return;
    const sample = sampleRoutePath(path, state.distanceM, this.sampleTarget);
    const crossings = this.findSignalCrossings(path, legStart, legEnd, edges, path.mode, sample.x, sample.y);
    for (const crossing of crossings) {
      const frontInside = state.distanceM + halfLength - crossing.stopLineDistanceM;
      if (frontInside < -0.5 || frontInside > crossing.pathLengthM + halfLength) continue;
      let occupied = false;
      try {
        occupied = crossing.controller.isOccupied();
      } catch {
        occupied = false;
      }
      if (occupied) {
        state.distanceM = Math.max(legStart, crossing.stopLineDistanceM - halfLength - 1);
        state.speedMps = 0;
        state.phase = 'signal';
        state.blockedReason = 'signal';
        state.zoneHold = {
          nodeId: crossing.nodeId,
          movementId: crossing.movementId,
          controller: crossing.controller,
        };
        return;
      }
      try {
        crossing.controller.enter(crossing.movementId, Math.max(0, frontInside));
        state.signal = {
          nodeId: crossing.nodeId,
          movementId: crossing.movementId,
          controller: crossing.controller,
          stopLineDistanceM: crossing.stopLineDistanceM,
          pathLengthM: crossing.pathLengthM,
        };
      } catch {
        state.signal = null;
      }
      return;
    }
  }

  private stepActiveTrip(
    state: ActiveTrip,
    dtSeconds: number,
    serviceDate: string,
    seconds: number,
    leaders: ReadonlyMap<string, readonly LeaderInfo[]>,
  ): void {
    const path = state.route.path;
    const stopTimes = state.trip.stopTimes;
    const halfLength = state.profile.bodyLengthM / 2;
    const now = this.stateNowSeconds(state, serviceDate, seconds);

    if (state.finished) {
      state.speedMps = 0;
      return;
    }

    if (state.atStop) {
      const stopIndex = state.nextStop;
      if (stopIndex < 0 || stopIndex >= stopTimes.length) {
        this.finishTrip(state, now);
        return;
      }
      const stopTime = stopTimes[stopIndex] as MobilityStopTime;
      const stopDistance = path.stopDistancesM[stopIndex] ?? state.distanceM;
      const holdUntil = state.holdUntilS ?? now;
      const leader = this.leaderAhead(state, leaders);
      let queueBlocked = false;
      if (leader) {
        const gap = leader.distanceM - leader.bodyLengthM / 2 - (stopDistance + halfLength);
        if (gap < state.profile.safetyGapM - TIME_EPSILON_S) queueBlocked = true;
      }
      state.distanceM = stopDistance;
      state.speedMps = 0;
      this.updateSignalOccupancy(state);
      if (!queueBlocked && now + TIME_EPSILON_S < holdUntil) {
        const dwellEnd = (state.actualArrivalS ?? now) + state.stopDwellS;
        state.phase = now + TIME_EPSILON_S < dwellEnd ? 'dwelling' : 'waiting';
        state.blockedReason = null;
        return;
      }
      if (queueBlocked) {
        state.phase = 'waiting';
        state.blockedReason = 'queue';
        return;
      }
      // Отправление: задержка фиксируется и переносится дальше.
      state.delayS = Math.max(state.delayS, now - stopTime.departureS);
      this.delays.set(state.trip.id, state.delayS);
      state.atStop = false;
      state.actualArrivalS = null;
      state.holdUntilS = null;
      state.stopDwellS = 0;
      state.blockedReason = null;
      state.phase = 'moving';
      state.nextStop = stopIndex + 1;
      this.releaseExitBlocks(state);
      if (state.nextStop >= stopTimes.length) {
        this.finishTrip(state, now);
      }
      return;
    }

    const stopIndex = state.nextStop;
    if (stopIndex <= 0 || stopIndex >= stopTimes.length) {
      this.finishTrip(state, now);
      return;
    }
    const stopTime = stopTimes[stopIndex] as MobilityStopTime;
    const targetStopDistance = path.stopDistancesM[stopIndex] ?? path.lengthM;
    const remainingToStop = Math.max(0, targetStopDistance - state.distanceM);
    const scheduledArrival = stopTime.arrivalS + state.delayS;
    const paceSpeed = schedulePaceSpeed(
      remainingToStop,
      scheduledArrival - now,
      state.profile.maxSpeedMps,
      state.profile.minCruiseMps,
    );

    const legStart = path.stopDistancesM[stopIndex - 1] ?? 0;
    const edges = this.legEdgeIds(path, stopIndex - 1, stopIndex);
    const sample = sampleRoutePath(path, state.distanceM, this.sampleTarget);
    const crossings = this.findSignalCrossings(
      path,
      legStart,
      targetStopDistance,
      edges,
      path.mode,
      sample.x,
      sample.y,
    );

    let stopDistance = remainingToStop;
    let blocking: 'stop' | 'signal' | 'queue' = 'stop';
    let pendingCrossing: SignalCrossing | null = null;

    // Очередь: держим зазор до впереди идущей машины в той же полосе (тот же путь).
    const leader = this.leaderAhead(state, leaders);
    if (leader) {
      const leaderRear = leader.distanceM - leader.bodyLengthM / 2;
      const available = leaderRear - state.profile.safetyGapM - halfLength - state.distanceM;
      if (available < stopDistance) {
        stopDistance = Math.max(0, available);
        blocking = 'queue';
      }
    }

    // Ближайший светофор впереди в пределах перегона.
    let nearest: SignalCrossing | null = null;
    for (const crossing of crossings) {
      // Собственный уже занятый манёвр не выбираем повторно.
      if (state.signal && crossing.nodeId === state.signal.nodeId) continue;
      // Стоп-линия считается впереди, пока передний габарит её не пересёк:
      // иначе стоящая у линии машина «забывала» бы красный и уезжала.
      if (crossing.stopLineDistanceM < state.distanceM + halfLength - 1e-6) continue;
      if (crossing.stopLineDistanceM > targetStopDistance + 1) continue;
      nearest = crossing;
      break;
    }
    if (state.zoneHold && (!nearest || nearest.nodeId !== state.zoneHold.nodeId)) {
      state.zoneHold = null;
    }
    if (nearest) {
      const distanceToLine = nearest.stopLineDistanceM - state.distanceM - halfLength;
      const exit = this.exitInfo(state, nearest, leaders);
      this.setExitBlocked(state, nearest, exit.exitBlocked);
      let allowed = false;
      const zoneBusy = this.zoneHoldBusy(state, nearest);
      // Один манёвр = одна конфликтная зона: если в ней уже есть машина
      // (например, та же полоса), вторая не въезжает, даже если контроллер
      // считает занятость «своей».
      let movementBusy = false;
      try {
        movementBusy = nearest.controller.isOccupied(nearest.movementId);
      } catch {
        movementBusy = false;
      }
      if (zoneBusy || movementBusy) {
        allowed = false;
      } else {
        const aspect = this.movementAspect(nearest.controller, nearest.movementId);
        if (aspect === 'yellow') {
          const held = state.yellowHold;
          const sameSignal =
            held !== null && held.nodeId === nearest.nodeId && held.movementId === nearest.movementId;
          if (sameSignal) {
            // Решение на жёлтый фиксируется один раз: водитель либо тормозит,
            // либо заканчивает въезд. Повторная оценка у самой линии иначе
            // всегда превращалась бы в «уже поздно тормозить».
            allowed = held.stop === false;
          } else {
            allowed = this.canEnterSignal(state, nearest, distanceToLine, exit);
            state.yellowHold = {
              nodeId: nearest.nodeId,
              movementId: nearest.movementId,
              stop: !allowed,
            };
          }
        } else {
          state.yellowHold = null;
          allowed = this.canEnterSignal(state, nearest, distanceToLine, exit);
        }
      }
      if (allowed) {
        pendingCrossing = nearest;
        this.releaseExitBlocksExcept(state, nearest);
      } else if (distanceToLine < stopDistance) {
        stopDistance = Math.max(0, distanceToLine);
        blocking = 'signal';
        this.releaseExitBlocksExcept(state, nearest);
      }
    } else {
      this.releaseExitBlocks(state);
      state.yellowHold = null;
    }

    const previousSpeed = state.speedMps;
    const motion = advanceMotion(
      { distanceM: state.distanceM, speedMps: state.speedMps },
      dtSeconds,
      state.profile,
      { targetSpeedMps: paceSpeed, stopDistanceM: stopDistance },
    );
    state.distanceM = motion.distanceM;
    state.speedMps = motion.speedMps;

    // Пересечение стоп-линии: только если въезд разрешён в этом шаге.
    if (!state.signal && pendingCrossing) {
      const front = state.distanceM + halfLength;
      if (front >= pendingCrossing.stopLineDistanceM - 1e-6) {
        try {
          pendingCrossing.controller.enter(pendingCrossing.movementId, 0);
          state.signal = {
            nodeId: pendingCrossing.nodeId,
            movementId: pendingCrossing.movementId,
            controller: pendingCrossing.controller,
            stopLineDistanceM: pendingCrossing.stopLineDistanceM,
            pathLengthM: pendingCrossing.pathLengthM,
          };
        } catch {
          state.signal = null;
        }
        state.yellowHold = null;
        state.zoneHold = null;
        this.setExitBlocked(state, pendingCrossing, false);
      }
    }

    if (state.distanceM >= targetStopDistance - ARRIVAL_EPSILON_M) {
      state.distanceM = targetStopDistance;
      state.speedMps = 0;
      this.arriveAtStop(state, now, stopTime);
      this.updateSignalOccupancy(state);
      return;
    }

    if (motion.speedMps <= 0.01) {
      state.blockedReason = blocking === 'signal' ? 'signal' : blocking === 'queue' ? 'queue' : null;
      state.phase = blocking === 'signal' ? 'signal' : blocking === 'queue' ? 'waiting' : 'braking';
    } else if (motion.speedMps < previousSpeed - 0.01) {
      state.blockedReason = null;
      state.phase = 'braking';
    } else {
      state.blockedReason = null;
      state.phase = 'moving';
    }
    this.updateSignalOccupancy(state);
  }

  private arriveAtStop(state: ActiveTrip, now: number, stopTime: MobilityStopTime): void {
    const stopIndex = state.nextStop;
    const path = state.route.path;
    const stopCall = path.stopCalls[stopIndex];
    const scheduledArrival = stopTime.arrivalS;
    const scheduledDeparture = stopTime.departureS;
    const scheduledDwell = Math.max(0, scheduledDeparture - scheduledArrival);
    const modelDwell = stopCall && Number.isFinite(stopCall.dwellS) ? Math.max(0, stopCall.dwellS) : 0;
    state.atStop = true;
    state.actualArrivalS = now;
    state.stopDwellS = scheduledDwell > 0 ? scheduledDwell : modelDwell;
    state.holdUntilS = Math.max(scheduledDeparture + state.delayS, now + state.stopDwellS);
    state.phase = state.stopDwellS > TIME_EPSILON_S ? 'dwelling' : 'waiting';
    state.blockedReason = null;
    state.yellowHold = null;
    state.zoneHold = null;
    this.releaseExitBlocks(state);
  }

  private finishTrip(state: ActiveTrip, now: number): void {
    this.detachState(state);
    state.finished = true;
    state.finishedAtS = now;
    state.atStop = false;
    state.holdUntilS = null;
    state.actualArrivalS = null;
    state.stopDwellS = 0;
    state.speedMps = 0;
    state.phase = 'finished';
    state.nextStop = -1;
    state.blockedReason = null;
    this.delays.set(state.trip.id, state.delayS);
  }

  /** Снимает занятость узла и внешние блокировки выхода у рейса. */
  private detachState(state: ActiveTrip): void {
    this.releaseExitBlocks(state);
    state.yellowHold = null;
    state.zoneHold = null;
    if (state.signal) {
      try {
        state.signal.controller.exit(state.signal.movementId);
      } catch {
        // Контроллер мог быть удалён вместе с релизом данных.
      }
      state.signal = null;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Светофоры и очередь.                                                    */
  /* ----------------------------------------------------------------------- */

  private legEdgeIds(path: RoutePath, fromStop: number, toStop: number): Set<string> {
    const result = new Set<string>();
    const edges = path.edges;
    if (edges.length === 0) return result;
    const fromIndex = path.stopEdgeIndex[fromStop] ?? -1;
    const toIndex = path.stopEdgeIndex[toStop] ?? -1;
    if (toIndex >= 0 && toIndex < edges.length) {
      const start =
        fromIndex >= 0 && fromIndex <= toIndex ? fromIndex : Math.max(0, toIndex - 1);
      for (let index = start; index <= toIndex; index += 1) {
        const edgeId = edges[index];
        if (edgeId) result.add(edgeId);
      }
    }
    if (fromIndex >= 0 && fromIndex < edges.length) {
      const edgeId = edges[fromIndex];
      if (edgeId) result.add(edgeId);
    }
    return result;
  }

  /** Светофоры на перегоне: подход по ребру, проекция стоп-линии на путь. */
  private findSignalCrossings(
    path: RoutePath,
    legStartS: number,
    legEndS: number,
    edgeIds: ReadonlySet<string>,
    mode: MobilityMode,
    originX: number,
    originY: number,
  ): SignalCrossing[] {
    if (edgeIds.size === 0 || !(legEndS > legStartS - TIME_EPSILON_S)) return [];
    let entries: ReturnType<TripWorld['getSignalsNear']>;
    try {
      entries = this.world.getSignalsNear(originX, originY, this.maxSignalRadiusM);
    } catch {
      return [];
    }
    if (!entries || entries.length === 0) return [];
    const kind = mode === 'tram' ? 'tram' : 'vehicle';
    const byNode = new Map<string, SignalCrossing>();
    for (const entry of entries) {
      if (!entry || !entry.controller) continue;
      const node = entry.controller.node;
      if (!node || !Array.isArray(node.movements) || !Array.isArray(node.stopLines)) continue;
      let best: SignalCrossing | null = null;
      for (let movementIndex = 0; movementIndex < node.movements.length; movementIndex += 1) {
        const movement = node.movements[movementIndex];
        if (!movement || movement.kind !== kind) continue;
        if (!edgeIds.has(movement.approach.edgeId)) continue;
        const stopLine = node.stopLines.find((line) => line.movement === movementIndex);
        if (!stopLine) continue;
        const point = stopLineMidpoint(stopLine, node.x, node.y);
        const projection = projectPointOntoPath(path, point.x, point.y, legStartS, legEndS);
        if (!projection || projection.lateralM > MAX_SIGNAL_LATERAL_M) continue;
        const candidate: SignalCrossing = {
          nodeId: node.id,
          movementId: movement.id,
          controller: entry.controller,
          stopLineDistanceM: projection.distanceM,
          pathLengthM: Math.max(
            0,
            mobilityPolylineLength(movement.path?.p ?? [], movement.path?.s),
          ),
          clearanceLengthM: Math.max(0, movement.clearanceLengthM ?? 0),
          lateralM: projection.lateralM,
        };
        if (
          best === null ||
          candidate.lateralM < best.lateralM - 1e-9 ||
          (Math.abs(candidate.lateralM - best.lateralM) <= 1e-9 &&
            candidate.stopLineDistanceM < best.stopLineDistanceM)
        ) {
          best = candidate;
        }
      }
      if (!best) continue;
      const existing = byNode.get(best.nodeId);
      if (!existing || best.lateralM < existing.lateralM) byNode.set(best.nodeId, best);
    }
    return [...byNode.values()].sort((left, right) => {
      if (left.stopLineDistanceM !== right.stopLineDistanceM) {
        return left.stopLineDistanceM - right.stopLineDistanceM;
      }
      return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
    });
  }

  /** Аспект группы, которой подчиняется манёвр (для фиксации решения на жёлтый). */
  private movementAspect(
    controller: import('./signals').SignalController,
    movementId: string,
  ): MobilityAspect | null {
    const node = controller.node;
    if (!node) return null;
    const movement = node.movements.find((candidate) => candidate.id === movementId);
    if (!movement) return null;
    const group = node.groups[movement.group];
    if (!group) return null;
    try {
      return controller.aspects()[group.id] ?? null;
    } catch {
      return null;
    }
  }

  private canEnterSignal(
    state: ActiveTrip,
    crossing: SignalCrossing,
    distanceToLine: number,
    exit: { exitClear: boolean; exitDistanceM?: number },
  ): boolean {
    try {
      return crossing.controller.canEnter(crossing.movementId, {
        distanceToStopLineM: Math.max(distanceToLine, 0),
        speedMps: state.speedMps,
        brakingMps2: state.profile.brakingMps2,
        reactionS: state.profile.reactionS,
        exitClear: exit.exitClear,
        exitDistanceM: exit.exitDistanceM,
      });
    } catch {
      return false;
    }
  }

  /**
   * Занятая конфликтная зона, в которой рейс не должен оказаться при появлении
   * из невидимой области. Пока зона занята, машина стоит перед стоп-линией.
   */
  private zoneHoldBusy(state: ActiveTrip, crossing: SignalCrossing): boolean {
    const hold = state.zoneHold;
    if (!hold || hold.nodeId !== crossing.nodeId) return false;
    let occupied = false;
    try {
      occupied = hold.controller.isOccupied();
    } catch {
      occupied = false;
    }
    if (!occupied) {
      state.zoneHold = null;
      return false;
    }
    return true;
  }

  private exitInfo(
    state: ActiveTrip,
    crossing: SignalCrossing,
    leaders: ReadonlyMap<string, readonly LeaderInfo[]>,
  ): { exitClear: boolean; exitDistanceM?: number; exitBlocked: boolean } {
    const leader = this.leaderAhead(state, leaders);
    if (!leader) return { exitClear: true, exitBlocked: false };
    const leaderRear = leader.distanceM - leader.bodyLengthM / 2;
    if (leaderRear <= crossing.stopLineDistanceM) {
      // Машина ещё до стоп-линии: это очередь, а не занятый выход.
      return { exitClear: true, exitBlocked: false };
    }
    const available = leaderRear - crossing.stopLineDistanceM;
    const needed = crossing.clearanceLengthM + DEFAULT_EXIT_MARGIN_M;
    const clear = available >= needed;
    return clear
      ? { exitClear: true, exitDistanceM: available, exitBlocked: false }
      : { exitClear: false, exitDistanceM: available, exitBlocked: true };
  }

  private setExitBlocked(state: ActiveTrip, crossing: SignalCrossing, blocked: boolean): void {
    const key = `${crossing.nodeId}|${crossing.movementId}`;
    const existing = state.blockedExits.get(key);
    if (blocked && !existing) {
      try {
        crossing.controller.setExitBlocked(crossing.movementId, true);
        state.blockedExits.set(key, {
          controller: crossing.controller,
          movementId: crossing.movementId,
        });
      } catch {
        // Узел мог быть выгружен: внешняя блокировка больше не актуальна.
      }
    } else if (!blocked && existing) {
      try {
        existing.controller.setExitBlocked(existing.movementId, false);
      } catch {
        // см. выше
      }
      state.blockedExits.delete(key);
    }
  }

  private releaseExitBlocksExcept(state: ActiveTrip, crossing: SignalCrossing): void {
    const keep = `${crossing.nodeId}|${crossing.movementId}`;
    for (const [key, entry] of [...state.blockedExits]) {
      if (key === keep) continue;
      try {
        entry.controller.setExitBlocked(entry.movementId, false);
      } catch {
        // см. выше
      }
      state.blockedExits.delete(key);
    }
  }

  private releaseExitBlocks(state: ActiveTrip): void {
    for (const [key, entry] of [...state.blockedExits]) {
      try {
        entry.controller.setExitBlocked(entry.movementId, false);
      } catch {
        // см. выше
      }
      state.blockedExits.delete(key);
    }
  }

  private releaseAllSignalState(): void {
    for (const state of this.states.values()) {
      this.detachState(state);
    }
  }

  /**
   * Обновляет занятость манёвра по положению передней точки.
   *
   * `0` — стоп-линия, длина пути манёвра — свободный выход. Контроллер сам
   * снимает занятость, когда хвост кузова прошёл конец пути; `exit()` вызывается
   * явно для полноты контракта.
   */
  private updateSignalOccupancy(state: ActiveTrip): void {
    const active = state.signal;
    if (!active) return;
    const halfLength = state.profile.bodyLengthM / 2;
    const position = Math.max(0, state.distanceM + halfLength - active.stopLineDistanceM);
    let transition: string = 'inside';
    try {
      transition = active.controller.updatePosition(active.movementId, position);
    } catch {
      state.signal = null;
      return;
    }
    if (transition === 'exited') {
      try {
        active.controller.exit(active.movementId);
      } catch {
        // см. выше
      }
      state.signal = null;
    }
  }

  private leaderAhead(
    state: ActiveTrip,
    leaders: ReadonlyMap<string, readonly LeaderInfo[]>,
  ): LeaderInfo | null {
    const list = leaders.get(state.variantId);
    if (!list || list.length === 0) return null;
    for (const item of list) {
      if (item.tripId === state.trip.id) continue;
      if (item.distanceM > state.distanceM + 0.01) return item;
      // Две машины в одной точке: впереди считается меньший tripId, чтобы
      // порядок был детерминированным и вторая не въехала в первую.
      if (Math.abs(item.distanceM - state.distanceM) <= 0.01 && item.tripId < state.trip.id) {
        return item;
      }
    }
    return null;
  }

  /** Позиции всех рейсов варианта (моделируемых и аналитических) для очереди. */
  private buildLeaderIndex(): Map<string, LeaderInfo[]> {
    const map = new Map<string, LeaderInfo[]>();
    const push = (variantId: string, info: LeaderInfo): void => {
      let list = map.get(variantId);
      if (!list) {
        list = [];
        map.set(variantId, list);
      }
      list.push(info);
    };
    for (const state of this.states.values()) {
      if (state.finished) continue;
      push(state.variantId, {
        tripId: state.trip.id,
        distanceM: state.distanceM,
        bodyLengthM: state.profile.bodyLengthM,
      });
    }
    for (const frame of this.latestActive) {
      if (this.states.has(frame.trip.id)) continue;
      const record = this.routes.get(frame.trip.variantId);
      if (!record) continue;
      const analytic = this.analyticState(frame, record.path);
      push(frame.trip.variantId, {
        tripId: frame.trip.id,
        distanceM: analytic.distanceM,
        bodyLengthM: this.profileFor(record.path.mode).bodyLengthM,
      });
    }
    for (const list of map.values()) {
      list.sort((left, right) => {
        if (left.distanceM !== right.distanceM) return left.distanceM - right.distanceM;
        return left.tripId < right.tripId ? -1 : left.tripId > right.tripId ? 1 : 0;
      });
    }
    return map;
  }

  /* ----------------------------------------------------------------------- */
  /* Аналитические рейсы и снимки.                                           */
  /* ----------------------------------------------------------------------- */

  private analyticState(frame: ActiveScheduledTrip, path: RoutePath): AnalyticState {
    const trip = frame.trip;
    const delay = this.delays.get(trip.id) ?? 0;
    const virtual = frame.serviceSeconds - delay;
    const profile = this.profileFor(path.mode);
    let phase;
    try {
      phase = tripPhaseAt(trip, virtual);
    } catch {
      return {
        distanceM: path.stopDistancesM[0] ?? 0,
        speedMps: 0,
        phase: 'waiting',
        nextStop: 0,
      };
    }
    switch (phase.kind) {
      case 'at-stop': {
        const stopIndex = phase.stopIndex;
        return {
          distanceM: path.stopDistancesM[stopIndex] ?? 0,
          speedMps: 0,
          phase: 'dwelling',
          nextStop: stopIndex,
        };
      }
      case 'between-stops': {
        const from = phase.fromIndex;
        const to = phase.toIndex;
        const startS = path.stopDistancesM[from] ?? 0;
        const endS = path.stopDistancesM[to] ?? startS;
        const progress = Math.max(0, Math.min(1, phase.progress));
        const distanceM = startS + progress * (endS - startS);
        const speedMps = schedulePaceSpeed(
          endS - distanceM,
          phase.phaseEndS - virtual,
          profile.maxSpeedMps,
          profile.minCruiseMps,
        );
        return { distanceM, speedMps, phase: 'moving', nextStop: to };
      }
      case 'before-start':
        return {
          distanceM: path.stopDistancesM[0] ?? 0,
          speedMps: 0,
          phase: 'waiting',
          nextStop: 0,
        };
      default:
        return {
          distanceM: path.stopDistancesM[path.stopDistancesM.length - 1] ?? 0,
          speedMps: 0,
          phase: 'finished',
          nextStop: -1,
        };
    }
  }

  private snapshotForState(state: ActiveTrip): MobilityTripSnapshot {
    const path = state.route.path;
    const sample = sampleRoutePath(path, state.distanceM, this.sampleTarget);
    return {
      tripId: state.trip.id,
      variantId: state.variantId,
      mode: path.mode,
      ref: path.ref,
      phase: state.finished ? 'finished' : state.phase,
      x: sample.x,
      y: sample.y,
      h: sample.h,
      heading: sample.heading,
      speed: state.speedMps,
      delayS: state.delayS,
      nextStop: state.finished ? -1 : state.nextStop,
      routeVariant: state.variantId,
      drawn: false,
    };
  }

  private snapshotForAnalytic(
    frame: ActiveScheduledTrip,
    record: RouteRecord,
  ): MobilityTripSnapshot {
    const analytic = this.analyticState(frame, record.path);
    const sample = sampleRoutePath(record.path, analytic.distanceM, this.sampleTarget);
    return {
      tripId: frame.trip.id,
      variantId: frame.trip.variantId,
      mode: record.path.mode,
      ref: record.path.ref,
      phase: analytic.phase,
      x: sample.x,
      y: sample.y,
      h: sample.h,
      heading: sample.heading,
      speed: analytic.speedMps,
      delayS: this.delays.get(frame.trip.id) ?? 0,
      nextStop: analytic.nextStop,
      routeVariant: frame.trip.variantId,
      drawn: false,
    };
  }

  private refreshStats(): void {
    let modelled = 0;
    let blocked = 0;
    let delayed = 0;
    for (const state of this.states.values()) {
      if (state.finished) continue;
      modelled += 1;
      if (state.blockedReason) blocked += 1;
      if (state.delayS > DELAY_EPSILON_S) delayed += 1;
    }
    let analytic = 0;
    let analyticDelayed = 0;
    for (const frame of this.latestActive) {
      if (this.states.has(frame.trip.id)) continue;
      if (!this.routes.has(frame.trip.variantId)) continue;
      analytic += 1;
      const delay = this.delays.get(frame.trip.id) ?? 0;
      if (delay > DELAY_EPSILON_S) analyticDelayed += 1;
    }
    let approximatedVariants = 0;
    for (const record of this.routes.values()) {
      if (!record.exact) approximatedVariants += 1;
    }
    this.stats = {
      activeTrips: modelled + analytic,
      blockedTrips: blocked,
      delayedTrips: delayed + analyticDelayed,
      scheduledToday: this.scheduledToday,
      modelledTrips: modelled,
      analyticTrips: analytic,
      approximatedVariants,
      calendarSource: this.calendarSource,
    };
  }
}
