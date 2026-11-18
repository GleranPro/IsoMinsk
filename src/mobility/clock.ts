/**
 * Isometric Minsk — единые часы симуляции.
 *
 * Часы — единственный источник модельного времени для транспорта, светофоров и
 * будущих пешеходов. Свойства:
 *
 *  - фиксированный шаг (`stepHz`, по умолчанию 10 Гц): поведение не зависит от
 *    render FPS, а рендер интерполирует состояние по `alpha`;
 *  - число догоняющих шагов за кадр ограничено (`maxCatchUpSteps`): длинный
 *    кадр или скрытая вкладка не вызывают длинного расчёта, лишнее время
 *    отбрасывается, а не копится;
 *  - пауза не копит время: во время паузы `advance()` не накапливает реальные
 *    секунды, после снятия паузы «долг» не догоняется;
 *  - время обслуживания вычисляется в IANA-зоне расписания (`timeZone`, по
 *    умолчанию `Europe/Minsk`), а не в зоне браузера. Форматирование идёт через
 *    `Intl.DateTimeFormat`, поэтому результат не зависит от машины;
 *  - для QA можно задать явную фиксированную дату/время (`fixedDate`,
 *    `fixedTimeSeconds`) и детерминированный seed;
 *  - время освещения сюда не входит: этот модуль отвечает только за модельные
 *    часы, а не за солнце/сутки сцены.
 *
 * День обслуживания начинается в 00:00 местного времени зоны расписания.
 * `serviceSeconds` — секунды от начала текущих местных суток в диапазоне
 * `[0, 86400)`; рейсы после полуночи продолжает счёт сам `schedule.ts`, поэтому
 * часам не нужно «заворачивать» дату назад.
 */

import { SECONDS_PER_DAY, isValidIsoDate } from './schedule';

/** Частота фиксированного шага по умолчанию, Гц. */
export const DEFAULT_STEP_HZ = 10;

/** Максимум догоняющих шагов за вызов `advance()` по умолчанию. */
export const DEFAULT_MAX_CATCH_UP_STEPS = 5;

/** Часовой пояс расписания по умолчанию. */
export const DEFAULT_TIME_ZONE = 'Europe/Minsk';

/** Seed генератора по умолчанию. */
export const DEFAULT_SEED = 1;

/** Допуск (в шагах) для границ фиксированного шага: только против float-дрейфа. */
const STEP_EPSILON_STEPS = 1e-6;

const MS_PER_SECOND = 1000;
const UINT32_RANGE = 4_294_967_296;

/* ------------------------------------------------------------------------- */
/* Гражданское время в IANA-зоне.                                            */
/* ------------------------------------------------------------------------- */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function validateTimeZone(timeZone: string): void {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new RangeError('Не задан часовой пояс расписания');
  }
  try {
    formatterFor(timeZone);
  } catch {
    throw new RangeError(`Неизвестный часовой пояс: "${timeZone}"`);
  }
}

function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  let year = Number.NaN;
  let month = Number.NaN;
  let day = Number.NaN;
  let hour = Number.NaN;
  let minute = Number.NaN;
  let second = Number.NaN;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    throw new RangeError(`Не удалось разобрать местное время для зоны "${timeZone}"`);
  }
  return { year, month, day, hour, minute, second };
}

function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, '0');
}

/** Смещение зоны относительно UTC для конкретного мгновения, миллисекунды. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const wholeSecond = Math.floor(epochMs / MS_PER_SECOND) * MS_PER_SECOND;
  return asUtc - wholeSecond;
}

/**
 * Местные дата и время в IANA-зоне → UTC-миллисекунды.
 *
 * Часовые пояса с переходом на летнее время обрабатываются итеративно. Для
 * несуществующего местного времени (например, 02:30 в день весеннего перевода)
 * результат привязывается к ближайшему существующему мгновению; `Europe/Minsk`
 * переводов не имеет, поэтому для расписания Минска неоднозначности нет.
 *
 * @throws RangeError на некорректные поля или неизвестную зону.
 */
export function civilDateTimeToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) {
    throw new RangeError('Дата и время должны состоять из целых полей');
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new RangeError(`Некорректное местное время: ${hour}:${minute}:${second}`);
  }
  const isoDate = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  if (!isValidIsoDate(isoDate)) {
    throw new RangeError(`Некорректная дата: "${isoDate}"`);
  }
  validateTimeZone(timeZone);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = utcGuess - zoneOffsetMs(utcGuess, timeZone);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = utcGuess - zoneOffsetMs(candidate, timeZone);
    if (next === candidate) break;
    candidate = next;
  }
  return candidate;
}

/** Разбирает строгую ISO-дату на поля. */
function parseIsoDateParts(value: string): { year: number; month: number; day: number } {
  if (!isValidIsoDate(value)) throw new RangeError(`Некорректная ISO-дата: "${value}"`);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return { year, month, day };
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed) || !Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) {
    throw new RangeError(`Seed должен быть целым в [0, ${UINT32_RANGE - 1}], получено: ${seed}`);
  }
  return seed >>> 0;
}

function validateFixedTimeSeconds(seconds: number): void {
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < 0 || seconds >= SECONDS_PER_DAY) {
    throw new RangeError(
      `Фиксированное время суток должно быть целым в [0, ${SECONDS_PER_DAY}), получено: ${seconds}`,
    );
  }
}

/* ------------------------------------------------------------------------- */
/* Часы.                                                                     */
/* ------------------------------------------------------------------------- */

/** Параметры `SimulationClock`. */
export interface SimulationClockOptions {
  /** Частота фиксированного шага, Гц. По умолчанию 10. */
  stepHz?: number;
  /** Максимум догоняющих шагов за один `advance()`, целое ≥ 1. По умолчанию 5. */
  maxCatchUpSteps?: number;
  /** IANA-зона расписания. По умолчанию `Europe/Minsk`. */
  timeZone?: string;
  /** Дата QA-сценария, ISO `YYYY-MM-DD`; `null`/не задана — живые часы. */
  fixedDate?: string | null;
  /** Секунды от местной полуночи для QA-сценария, целые `[0, 86400)`. */
  fixedTimeSeconds?: number;
  /** Seed детерминированного генератора (целое uint32). По умолчанию 1. */
  seed?: number;
  /** Начальное мгновение для живого режима (QA/тесты); по умолчанию `Date.now()`. */
  nowMs?: number;
  /** Стартовать на паузе. */
  paused?: boolean;
}

/**
 * Единые часы симуляции с фиксированным шагом.
 *
 * `advance(realSeconds)` накапливает реальное время, выполняет целое число
 * фиксированных шагов (не больше `maxCatchUpSteps`) и возвращает их количество.
 * Рендер читает `alpha` (долю незавершённого шага) и интерполирует позиции
 * между `steps - 1` и `steps`.
 *
 * Экземпляр не зависит от `requestAnimationFrame`, таймеров и часового пояса
 * браузера; пауза и повторная инициализация даты — явные операции.
 */
export class SimulationClock {
  /** Частота фиксированного шага, Гц. */
  readonly stepHz: number;
  /** Длительность фиксированного шага, секунды. */
  readonly stepSeconds: number;
  /** Максимум догоняющих шагов за вызов `advance()`. */
  readonly maxCatchUpSteps: number;
  /** IANA-зона расписания. */
  readonly timeZone: string;

  private readonly stepMilliseconds: number;
  private originEpochMs!: number;
  private totalSteps = 0;
  private accumulatorS = 0;
  private pausedValue: boolean;
  private fixedDateValue: string | null;
  private fixedTimeSecondsValue = 0;
  private initialSeed: number;
  private randomState = 0;
  private currentEpochMs = 0;
  private localDateValue = '1970-01-01';
  private localSecondsValue = 0;

  constructor(options: SimulationClockOptions = {}) {
    const stepHz = options.stepHz ?? DEFAULT_STEP_HZ;
    if (!Number.isFinite(stepHz) || stepHz <= 0) {
      throw new RangeError(`stepHz должен быть положительным конечным числом, получено: ${stepHz}`);
    }
    const maxCatchUpSteps = options.maxCatchUpSteps ?? DEFAULT_MAX_CATCH_UP_STEPS;
    if (!Number.isInteger(maxCatchUpSteps) || maxCatchUpSteps < 1) {
      throw new RangeError(
        `maxCatchUpSteps должен быть целым ≥ 1, получено: ${maxCatchUpSteps}`,
      );
    }
    const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    validateTimeZone(timeZone);

    this.stepHz = stepHz;
    this.stepSeconds = 1 / stepHz;
    this.stepMilliseconds = this.stepSeconds * MS_PER_SECOND;
    this.maxCatchUpSteps = maxCatchUpSteps;
    this.timeZone = timeZone;
    this.initialSeed = normalizeSeed(options.seed ?? DEFAULT_SEED);
    this.pausedValue = options.paused === true;
    this.fixedDateValue = null;
    this.randomState = this.initialSeed;

    const hasFixedTime = options.fixedTimeSeconds !== undefined;
    const hasFixedDate = options.fixedDate !== undefined && options.fixedDate !== null;
    if (hasFixedTime && !hasFixedDate) {
      throw new RangeError('fixedTimeSeconds задан без fixedDate');
    }
    if (hasFixedDate) {
      this.setFixedDateTime(options.fixedDate ?? null, options.fixedTimeSeconds ?? 0);
    } else {
      this.setLiveOrigin(options.nowMs ?? Date.now());
    }
  }

  /** Seed детерминированного генератора, заданный при создании (или `reseed()`). */
  get seed(): number {
    return this.initialSeed;
  }

  /** true, когда часы работают в живом режиме (не на фиксированной дате QA). */
  get isLive(): boolean {
    return this.fixedDateValue === null;
  }

  /** Фиксированная дата QA или `null` в живом режиме. */
  get fixedDate(): string | null {
    return this.fixedDateValue;
  }

  /** Фиксированное время суток QA в секундах; 0 в живом режиме. */
  get fixedTimeSeconds(): number {
    return this.fixedTimeSecondsValue;
  }

  /** Текущая дата дня обслуживания в зоне расписания, ISO `YYYY-MM-DD`. */
  get serviceDate(): string {
    return this.localDateValue;
  }

  /** Целые секунды от местной полуночи `[0, 86400)`. */
  get serviceSeconds(): number {
    return Math.floor(this.localSecondsValue);
  }

  /** Дробные секунды от местной полуночи (для плавной фазы и интерполяции). */
  get serviceSecondsExact(): number {
    return this.localSecondsValue;
  }

  /** Текущее модельное мгновение, UTC-миллисекунды. */
  get epochMs(): number {
    return this.currentEpochMs;
  }

  /** Сколько модельного времени прошло с инициализации, секунды. */
  get simulatedSeconds(): number {
    return this.totalSteps * this.stepSeconds;
  }

  /** Число выполненных фиксированных шагов с последней инициализации. */
  get stepCount(): number {
    return this.totalSteps;
  }

  /** Доля незавершённого фиксированного шага `[0, 1]` для интерполяции рендера. */
  get alpha(): number {
    if (this.pausedValue) return 0;
    return Math.min(Math.max(this.accumulatorS / this.stepSeconds, 0), 1);
  }

  /** true — время не идёт, `advance()` не накапливает секунды. */
  get paused(): boolean {
    return this.pausedValue;
  }

  /** Удобная запись паузы (как `MobilitySettings.paused`); время на паузе не копится. */
  set paused(paused: boolean) {
    this.setPaused(paused === true);
  }

  /**
   * Продвигает часы на `realSeconds` реального времени.
   *
   * Возвращает число выполненных фиксированных шагов. Нечисловые и
   * неположительные значения игнорируются (защита от сброса таймера).
   * Если накопилось больше `maxCatchUpSteps`, лишнее время отбрасывается:
   * длинный кадр или скрытая вкладка не приводят к длинному расчёту.
   */
  advance(realSeconds: number): number {
    if (this.pausedValue) return 0;
    if (!Number.isFinite(realSeconds) || realSeconds <= 0) return 0;
    this.accumulatorS += realSeconds;
    const availableSteps = Math.floor(this.accumulatorS / this.stepSeconds + STEP_EPSILON_STEPS);
    const steps = Math.min(availableSteps, this.maxCatchUpSteps);
    if (steps <= 0) return 0;
    this.totalSteps += steps;
    if (availableSteps > steps) {
      // Догоняющий лимит исчерпан: остаток отбрасывается, а не копится.
      this.accumulatorS = 0;
    } else {
      const leftover = this.accumulatorS - steps * this.stepSeconds;
      this.accumulatorS = Math.max(0, Math.min(leftover, this.stepSeconds));
    }
    this.recomputeLocal();
    return steps;
  }

  /**
   * Явное продвижение на целое число фиксированных шагов для QA.
   *
   * Работает независимо от паузы: это детерминированное продвижение сцены, а не
   * догоняющий расчёт по реальному времени. `alpha` при этом не меняется.
   */
  step(count = 1): number {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`Число шагов должно быть целым ≥ 0, получено: ${count}`);
    }
    if (count === 0) return 0;
    this.totalSteps += count;
    this.recomputeLocal();
    return count;
  }

  /** Ставит часы на паузу; накопленный неполный шаг сбрасывается, время не копится. */
  pause(): void {
    if (this.pausedValue) return;
    this.pausedValue = true;
    this.accumulatorS = 0;
  }

  /** Снимает паузу; время, прошедшее на паузе, не догоняется. */
  resume(): void {
    this.pausedValue = false;
  }

  /** Управление паузой без вызова `pause()`/`resume()` напрямую. */
  setPaused(paused: boolean): void {
    if (paused) this.pause();
    else this.resume();
  }

  /**
   * Явная переинициализация даты/времени для QA.
   *
   * `fixedDate = null` возвращает живые часы от текущего момента. Счётчики
   * шагов, накопитель и генератор сбрасываются — это «новый прогон», а не
   * продолжение; состояние паузы сохраняется.
   *
   * @throws RangeError на некорректной дате/времени.
   */
  setFixedDateTime(fixedDate: string | null, fixedTimeSeconds = 0): void {
    if (fixedDate === null) {
      this.setLiveOrigin(Date.now());
      return;
    }
    validateFixedTimeSeconds(fixedTimeSeconds);
    const parts = parseIsoDateParts(fixedDate);
    const total = fixedTimeSeconds;
    const hour = Math.floor(total / 3600);
    const minute = Math.floor((total % 3600) / 60);
    const second = total % 60;
    this.originEpochMs = Math.round(
      civilDateTimeToEpochMs(parts.year, parts.month, parts.day, hour, minute, second, this.timeZone),
    );
    this.fixedDateValue = fixedDate;
    this.fixedTimeSecondsValue = fixedTimeSeconds;
    this.resetTimeline();
  }

  /**
   * Перезапуск живых часов от указанного мгновения (по умолчанию — сейчас).
   *
   * @throws RangeError если `nowMs` не конечное число.
   */
  resetToNow(nowMs = Date.now()): void {
    this.setLiveOrigin(nowMs);
  }

  /** Сбрасывает детерминированный генератор к текущему seed. */
  resetRandom(): void {
    this.randomState = this.initialSeed >>> 0;
  }

  /** Меняет seed и сбрасывает генератор. */
  reseed(seed: number): void {
    this.initialSeed = normalizeSeed(seed);
    this.resetRandom();
  }

  /**
   * Детерминированное число `[0, 1)` (mulberry32).
   *
   * Одинаковый seed и одинаковая последовательность вызовов дают одинаковый
   * результат при любом render FPS. Не используется для интервалов расписания:
   * только для порядка/выбора в симуляции.
   */
  random(): number {
    this.randomState = (this.randomState + 0x6d2b79f5) >>> 0;
    let value = this.randomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
  }

  private setLiveOrigin(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError(`Начальное время должно быть конечным числом, получено: ${nowMs}`);
    }
    this.fixedDateValue = null;
    this.fixedTimeSecondsValue = 0;
    this.originEpochMs = Math.round(nowMs);
    this.resetTimeline();
  }

  private resetTimeline(): void {
    this.totalSteps = 0;
    this.accumulatorS = 0;
    this.resetRandom();
    this.recomputeLocal();
  }

  private recomputeLocal(): void {
    this.currentEpochMs = this.originEpochMs + Math.round(this.totalSteps * this.stepMilliseconds);
    const parts = zonedParts(this.currentEpochMs, this.timeZone);
    this.localDateValue = `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
    const milliseconds = ((this.currentEpochMs % MS_PER_SECOND) + MS_PER_SECOND) % MS_PER_SECOND;
    this.localSecondsValue =
      parts.hour * 3600 + parts.minute * 60 + parts.second + milliseconds / MS_PER_SECOND;
  }
}
