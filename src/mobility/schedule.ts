/**
 * Isometric Minsk — сервисный календарь и плановое время рейсов.
 *
 * Модуль чистой логики: здесь нет React, Three.js, `Date` и зависимости от
 * часового пояса браузера. Все даты — ISO `YYYY-MM-DD`; арифметика дат идёт
 * через номер гражданских суток от 1970-01-01 (алгоритм Howard Hinnant),
 * поэтому переходы месяцев/лет и високосные годы не зависят от `Date`.
 *
 * Время расписания — целые секунды от начала дня обслуживания в часовом поясе
 * источника (см. `MobilityServiceCalendar.timeZone`). Рейс после полуночи
 * продолжает счёт (`> 86400`) и не заворачивается; поэтому активный рейс даты
 * `D` в начале следующих календарных суток ищется в кадре `D` с секундами
 * `86400 + serviceSeconds`.
 *
 * Что здесь есть:
 *  - чистые функции ISO-дат и календаря (дни недели + исключения);
 *  - плановая фаза рейса (`tripPhaseAt`) до старта / на остановке / в пути /
 *    после конца;
 *  - интерполяция неполных рейсов по явной геометрической модели с флагом
 *    `interpolated` (никаких случайных интервалов);
 *  - прогноз прибытия из накопленной задержки;
 *  - класс `TripSchedule`, который индексирует календари и рейсы и умеет
 *    отвечать «какие рейсы идут в этот момент».
 */

import type {
  MobilityRouteVariant,
  MobilityServiceCalendar,
  MobilityStopCall,
  MobilityStopTime,
  MobilityTrip,
} from '../shared/mobility';

/** Секунд в сутках. Времена после полуночи продолжают счёт и превышают это значение. */
export const SECONDS_PER_DAY = 86_400;

/** Допуск сравнения секунд (данные расписания — целые секунды, допуск только от float). */
const TIME_EPSILON = 1e-6;

/** Формат ISO-даты, поддерживаемый контрактом. */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/* ------------------------------------------------------------------------- */
/* Гражданские даты без `Date` и без часового пояса.                         */
/* ------------------------------------------------------------------------- */

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Номер суток от 1970-01-01 для гражданской даты (проверка месяца/дня не входит). */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Обратное преобразование номера суток в гражданскую дату. */
function civilFromDays(dayNumber: number): CivilDate {
  const shifted = dayNumber + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) /
      365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPart = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPart + 2) / 5) + 1;
  const month = monthPart + (monthPart < 10 ? 3 : -9);
  return { year: year + (month <= 2 ? 1 : 0), month, day };
}

function parseIsoDate(value: string): CivilDate | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const roundTrip = civilFromDays(daysFromCivil(year, month, day));
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day) return null;
  return { year, month, day };
}

/** Проверяет строгую ISO-дату `YYYY-MM-DD` (включая реальность числа месяца). */
export function isValidIsoDate(value: string): boolean {
  return typeof value === 'string' && parseIsoDate(value) !== null;
}

/**
 * Номер гражданских суток от 1970-01-01 (может быть отрицательным).
 *
 * @throws RangeError если строка не является корректной ISO-датой.
 */
export function isoDateToDayNumber(value: string): number {
  const civil = parseIsoDate(value);
  if (!civil) throw new RangeError(`Некорректная ISO-дата: "${value}"`);
  return daysFromCivil(civil.year, civil.month, civil.day);
}

/** ISO-дата по номеру гражданских суток от 1970-01-01. */
export function dayNumberToIsoDate(dayNumber: number): string {
  if (!Number.isFinite(dayNumber) || !Number.isInteger(dayNumber)) {
    throw new RangeError(`Номер суток должен быть целым числом, получено: ${dayNumber}`);
  }
  const { year, month, day } = civilFromDays(dayNumber);
  const pad = (value: number, width: number): string => String(Math.abs(value)).padStart(width, '0');
  return `${year < 0 ? '-' : ''}${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** День недели ISO-даты: 0 = воскресенье … 6 = суббота (как в контракте). */
export function isoWeekday(value: string): number {
  const dayNumber = isoDateToDayNumber(value);
  return ((dayNumber + 4) % 7 + 7) % 7;
}

/** Сдвигает ISO-дату на целое число суток. */
export function addIsoDays(value: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new RangeError(`Сдвиг даты должен быть целым числом суток, получено: ${days}`);
  }
  return dayNumberToIsoDate(isoDateToDayNumber(value) + days);
}

/** Сравнивает две ISO-даты: −1, 0 или 1. */
export function compareIsoDates(a: string, b: string): number {
  const left = isoDateToDayNumber(a);
  const right = isoDateToDayNumber(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

/* ------------------------------------------------------------------------- */
/* Календарь обслуживания.                                                   */
/* ------------------------------------------------------------------------- */

interface CalendarIndex {
  startDay: number;
  endDay: number;
  weekdays: ReadonlySet<number>;
  exceptions: ReadonlyMap<string, 'add' | 'remove'>;
}

/**
 * Строит проверенный индекс календаря. Бросает RangeError на противоречивых
 * данных, чтобы импортёр не мог молча использовать испорченный календарь.
 */
function buildCalendarIndex(calendar: MobilityServiceCalendar): CalendarIndex {
  if (!calendar.id) throw new RangeError('У календаря отсутствует id');
  if (typeof calendar.timeZone !== 'string' || calendar.timeZone.length === 0) {
    throw new RangeError(`Календарь ${calendar.id}: не задан часовой пояс`);
  }
  const startDay = isoDateToDayNumber(calendar.startDate);
  const endDay = isoDateToDayNumber(calendar.endDate);
  if (startDay > endDay) {
    throw new RangeError(
      `Календарь ${calendar.id}: startDate ${calendar.startDate} позже endDate ${calendar.endDate}`,
    );
  }
  const weekdays = new Set<number>();
  for (const weekday of calendar.weekdays) {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new RangeError(`Календарь ${calendar.id}: недопустимый день недели ${weekday}`);
    }
    weekdays.add(weekday);
  }
  const exceptions = new Map<string, 'add' | 'remove'>();
  for (const exception of calendar.exceptions ?? []) {
    if (!isValidIsoDate(exception.date)) {
      throw new RangeError(`Календарь ${calendar.id}: некорректная дата исключения ${exception.date}`);
    }
    if (exception.kind !== 'add' && exception.kind !== 'remove') {
      throw new RangeError(`Календарь ${calendar.id}: недопустимый вид исключения ${exception.kind}`);
    }
    const existing = exceptions.get(exception.date);
    if (existing !== undefined && existing !== exception.kind) {
      throw new RangeError(
        `Календарь ${calendar.id}: дата ${exception.date} одновременно добавлена и отменена`,
      );
    }
    exceptions.set(exception.date, exception.kind);
  }
  return { startDay, endDay, weekdays, exceptions };
}

function calendarIndexActiveOnDay(
  index: CalendarIndex,
  isoDate: string,
  dayNumber: number,
): boolean {
  if (dayNumber < index.startDay || dayNumber > index.endDay) return false;
  const exception = index.exceptions.get(isoDate);
  if (exception !== undefined) return exception === 'add';
  return index.weekdays.has(((dayNumber + 4) % 7 + 7) % 7);
}

function calendarIndexActiveOn(index: CalendarIndex, isoDate: string): boolean {
  return calendarIndexActiveOnDay(index, isoDate, isoDateToDayNumber(isoDate));
}

/**
 * Работает ли календарь в указанную ISO-дату.
 *
 * Правила: дата должна входить в `[startDate, endDate]`; исключение `add`
 * включает день даже вне набора дней недели, `remove` выключает его; за
 * пределами периода действия календарь не работает даже при `add`
 * (границы — часть контракта календаря).
 *
 * @throws RangeError на некорректной дате или противоречивом календаре.
 */
export function calendarActiveOn(calendar: MobilityServiceCalendar, isoDate: string): boolean {
  return calendarIndexActiveOn(buildCalendarIndex(calendar), isoDate);
}

/* ------------------------------------------------------------------------- */
/* Плановая фаза рейса.                                                      */
/* ------------------------------------------------------------------------- */

/** Состояние планового рейса в момент времени. */
export type TripPhaseKind = 'before-start' | 'at-stop' | 'between-stops' | 'after-end';

/** Плановая фаза рейса; всегда определена, включая моменты до старта и после конца. */
export interface TripPhase {
  kind: TripPhaseKind;
  /** Индекс остановки, на которой стоит транспорт (`at-stop`), иначе −1. */
  stopIndex: number;
  /** Индекс остановки отправления (`between-stops`), иначе −1. */
  fromIndex: number;
  /** Индекс остановки прибытия (`between-stops`), иначе −1. */
  toIndex: number;
  /** Плановое начало текущей фазы, секунды от начала дня обслуживания. */
  phaseStartS: number;
  /** Плановый конец текущей фазы; для `before-start`/`after-end` равен началу. */
  phaseEndS: number;
  /** Доля 0…1 внутри фазы: 0 до старта, 1 после конца. */
  progress: number;
  /** Секунды от `phaseStartS`; отрицательны до старта и положительны после конца. */
  elapsedS: number;
}

/** Временной диапазон рейса (секунды от начала дня обслуживания). */
export interface TripTimeWindow {
  /** Плановое прибытие на первую остановку. */
  firstArrivalS: number;
  /** Плановое отправление с первой остановки. */
  firstDepartureS: number;
  /** Плановое прибытие на последнюю остановку. */
  lastArrivalS: number;
  /** Плановое отправление с последней остановки. */
  lastDepartureS: number;
}

/**
 * Проверяет времена остановок рейса и возвращает список проблем.
 *
 * Пустой список означает, что рейс пригоден для планирования. `seq` обязан
 * совпадать с индексом в массиве (контракт: индекс в `variant.stops`), времена
 * должны быть конечными, неотрицательными и неубывающими.
 */
export function tripStopTimeIssues(trip: MobilityTrip): string[] {
  const issues: string[] = [];
  const stopTimes = trip.stopTimes;
  if (!Array.isArray(stopTimes) || stopTimes.length === 0) {
    issues.push(`рейс ${trip.id}: пустой список времён остановок`);
    return issues;
  }
  let previousArrival = Number.NEGATIVE_INFINITY;
  let previousDeparture = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < stopTimes.length; index += 1) {
    const time = stopTimes[index];
    if (!time) {
      issues.push(`рейс ${trip.id}: нет времени остановки ${index}`);
      continue;
    }
    if (time.seq !== index) {
      issues.push(`рейс ${trip.id}: seq=${time.seq} не совпадает с индексом ${index}`);
    }
    if (!Number.isFinite(time.arrivalS) || !Number.isFinite(time.departureS)) {
      issues.push(`рейс ${trip.id}: нечисловое время остановки ${index}`);
      continue;
    }
    if (time.arrivalS < 0 || time.departureS < 0) {
      issues.push(`рейс ${trip.id}: отрицательное время остановки ${index}`);
    }
    if (!Number.isInteger(time.arrivalS) || !Number.isInteger(time.departureS)) {
      issues.push(`рейс ${trip.id}: время остановки ${index} не целые секунды`);
    }
    if (time.departureS < time.arrivalS - TIME_EPSILON) {
      issues.push(`рейс ${trip.id}: отправление раньше прибытия на остановке ${index}`);
    }
    if (time.arrivalS < previousArrival - TIME_EPSILON || time.arrivalS < previousDeparture - TIME_EPSILON) {
      issues.push(`рейс ${trip.id}: время остановки ${index} убывает относительно предыдущей`);
    }
    previousArrival = time.arrivalS;
    previousDeparture = time.departureS;
  }
  return issues;
}

/**
 * Временной диапазон рейса.
 *
 * @throws RangeError если времён нет; сами значения не переупорядочиваются.
 */
export function tripTimeWindow(trip: MobilityTrip): TripTimeWindow {
  const stopTimes = trip.stopTimes;
  if (stopTimes.length === 0) throw new RangeError(`Рейс ${trip.id} не имеет времён остановок`);
  const first = stopTimes[0];
  const last = stopTimes[stopTimes.length - 1];
  if (!first || !last) throw new RangeError(`Рейс ${trip.id} не имеет времён остановок`);
  return {
    firstArrivalS: first.arrivalS,
    firstDepartureS: first.departureS,
    lastArrivalS: last.arrivalS,
    lastDepartureS: last.departureS,
  };
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Плановая фаза рейса в момент `seconds` от начала дня обслуживания.
 *
 * Функция не зависит от даты и часового пояса: после полуночи передавайте
 * `86400 + serviceSeconds` для кадра предыдущего дня обслуживания. Ожидается,
 * что времена уже проверены `tripStopTimeIssues()`.
 *
 * @throws RangeError если секунды не конечны.
 */
export function tripPhaseAt(trip: MobilityTrip, seconds: number): TripPhase {
  if (!Number.isFinite(seconds)) {
    throw new RangeError(`Некорректное время рейса ${trip.id}: ${seconds}`);
  }
  const stopTimes = trip.stopTimes;
  if (stopTimes.length === 0) throw new RangeError(`Рейс ${trip.id} не имеет времён остановок`);
  const first = stopTimes[0];
  const last = stopTimes[stopTimes.length - 1];
  if (!first || !last) throw new RangeError(`Рейс ${trip.id} не имеет времён остановок`);

  if (seconds < first.arrivalS) {
    return {
      kind: 'before-start',
      stopIndex: -1,
      fromIndex: -1,
      toIndex: -1,
      phaseStartS: first.arrivalS,
      phaseEndS: first.arrivalS,
      progress: 0,
      elapsedS: seconds - first.arrivalS,
    };
  }
  for (let index = 0; index < stopTimes.length; index += 1) {
    const time = stopTimes[index];
    if (!time) continue;
    if (seconds >= time.arrivalS && seconds <= time.departureS) {
      const dwell = time.departureS - time.arrivalS;
      return {
        kind: 'at-stop',
        stopIndex: index,
        fromIndex: -1,
        toIndex: -1,
        phaseStartS: time.arrivalS,
        phaseEndS: time.departureS,
        progress: dwell > TIME_EPSILON ? clampProgress((seconds - time.arrivalS) / dwell) : 0,
        elapsedS: seconds - time.arrivalS,
      };
    }
    const next = stopTimes[index + 1];
    if (next && seconds > time.departureS && seconds < next.arrivalS) {
      const move = next.arrivalS - time.departureS;
      return {
        kind: 'between-stops',
        stopIndex: -1,
        fromIndex: index,
        toIndex: index + 1,
        phaseStartS: time.departureS,
        phaseEndS: next.arrivalS,
        progress: move > TIME_EPSILON ? clampProgress((seconds - time.departureS) / move) : 0,
        elapsedS: seconds - time.departureS,
      };
    }
  }
  return {
    kind: 'after-end',
    stopIndex: -1,
    fromIndex: -1,
    toIndex: -1,
    phaseStartS: last.departureS,
    phaseEndS: last.departureS,
    progress: 1,
    elapsedS: seconds - last.departureS,
  };
}

/** Идёт ли рейс в момент `seconds` (включая стоянку на конечных). */
export function tripActiveAt(trip: MobilityTrip, seconds: number): boolean {
  const window = tripTimeWindow(trip);
  return seconds >= window.firstArrivalS && seconds <= window.lastDepartureS;
}

/* ------------------------------------------------------------------------- */
/* Прогноз прибытия по накопленной задержке.                                 */
/* ------------------------------------------------------------------------- */

/**
 * Прогноз прибытия на остановку `stopIndex` при накопленной задержке `delayS`.
 *
 * Отрицательная задержка (раннее прибытие) не сдвигает прогноз раньше
 * расписания: транспорт ждёт планового отправления, поэтому эффективная
 * задержка ограничена снизу нулём. Это модель, а не измерение.
 *
 * @throws RangeError если индекс остановки вне диапазона.
 */
export function forecastArrivalS(trip: MobilityTrip, stopIndex: number, delayS: number): number {
  const stopTimes = trip.stopTimes;
  if (!Number.isInteger(stopIndex) || stopIndex < 0 || stopIndex >= stopTimes.length) {
    throw new RangeError(
      `Рейс ${trip.id}: индекс остановки ${stopIndex} вне диапазона 0…${stopTimes.length - 1}`,
    );
  }
  const time = stopTimes[stopIndex];
  if (!time) throw new RangeError(`Рейс ${trip.id}: нет времени остановки ${stopIndex}`);
  const effectiveDelay = Number.isFinite(delayS) ? Math.max(0, delayS) : 0;
  return time.arrivalS + effectiveDelay;
}

/* ------------------------------------------------------------------------- */
/* Интерполяция неполного рейса.                                             */
/* ------------------------------------------------------------------------- */

/** Время остановки с явным признаком «получено моделью, а не источником». */
export interface InterpolatedStopTime extends MobilityStopTime {
  /** true — значение вычислено документированной моделью интерполяции. */
  interpolated: boolean;
}

/** Результат интерполяции неполного рейса. */
export interface TripTimetable {
  /** Времена всех остановок в порядке варианта. */
  stopTimes: InterpolatedStopTime[];
  /** true только если источник дал все времена и модель не применялась. */
  complete: boolean;
  /** Индексы `seq`, вычисленные моделью (пусто у полного рейса). */
  interpolatedSeqs: number[];
}

/** Параметры модели интерполяции. */
export interface TripInterpolationOptions {
  /** Стоянка на промежуточной остановке, если `dwellS` не задан или отрицателен. */
  fallbackDwellS?: number;
}

/**
 * Расстояние между точками стоянки, метры.
 *
 * Если обе остановки лежат на одной полосе одного ребра, берётся разница
 * продольных координат `s` из контракта; иначе — прямое евклидово расстояние
 * (документированная модельная аппроксимация, повороты не учитываются).
 */
function stopCallDistanceM(a: MobilityStopCall, b: MobilityStopCall): number {
  if (
    a.edgeId === b.edgeId &&
    a.laneIndex === b.laneIndex &&
    Number.isFinite(a.s) &&
    Number.isFinite(b.s) &&
    b.s >= a.s
  ) {
    return b.s - a.s;
  }
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  return Number.isFinite(distance) ? distance : 0;
}

function roundedDwell(stop: MobilityStopCall | undefined, fallbackDwellS: number): number {
  const dwell =
    stop && Number.isFinite(stop.dwellS) && stop.dwellS >= 0 ? stop.dwellS : fallbackDwellS;
  return Math.max(0, Math.round(dwell));
}

/**
 * Заполняет промежуточные времена неполного рейса по явной модели.
 *
 * Модель: между двумя опубликованными опорными остановками время хода
 * распределяется пропорционально прямому расстоянию между точками остановки
 * (повороты не учитываются — это документированное ограничение), а на каждой
 * промежуточной остановке добавляется `dwellS` из варианта. Результат
 * округляется до целых секунд и не выходит за плановое прибытие следующей
 * опорной остановки. Опорными считаются первая, последняя и все остановки с
 * `MobilityStopCall.timed === true`.
 *
 * Функция не бросает «случайные» интервалы: при невозможных данных (обратный
 * ход времени, несовпадение числа остановок) она бросает RangeError.
 *
 * @throws RangeError на несогласованных входных данных.
 */
export function interpolateTripTimes(
  variant: MobilityRouteVariant,
  trip: MobilityTrip,
  options: TripInterpolationOptions = {},
): TripTimetable {
  const issues = tripStopTimeIssues(trip);
  if (issues.length > 0) throw new RangeError(issues.join('; '));
  const stops = variant.stops;
  const stopTimes = trip.stopTimes;
  if (stops.length !== stopTimes.length) {
    throw new RangeError(
      `Рейс ${trip.id}: ${stopTimes.length} времён на ${stops.length} остановок варианта ${variant.id}`,
    );
  }
  const fallbackDwellS = options.fallbackDwellS ?? 0;
  if (!Number.isFinite(fallbackDwellS) || fallbackDwellS < 0) {
    throw new RangeError(`Некорректная fallbackDwellS: ${fallbackDwellS}`);
  }

  const result: InterpolatedStopTime[] = stopTimes.map((time) => ({
    seq: time.seq,
    arrivalS: time.arrivalS,
    departureS: time.departureS,
    interpolated: false,
  }));
  const interpolatedSeqs: number[] = [];

  const anchors: number[] = [];
  for (let index = 0; index < stops.length; index += 1) {
    if (index === 0 || index === stops.length - 1 || stops[index]?.timed === true) {
      anchors.push(index);
    }
  }

  for (let anchorIndex = 0; anchorIndex + 1 < anchors.length; anchorIndex += 1) {
    const from = anchors[anchorIndex];
    const to = anchors[anchorIndex + 1];
    if (from === undefined || to === undefined) continue;
    const fromTime = stopTimes[from];
    const toTime = stopTimes[to];
    if (!fromTime || !toTime) continue;

    const dwells: number[] = [];
    let dwellTotal = 0;
    for (let index = from + 1; index < to; index += 1) {
      const dwell = roundedDwell(stops[index], fallbackDwellS);
      dwells.push(dwell);
      dwellTotal += dwell;
    }
    const rawMove = toTime.arrivalS - fromTime.departureS - dwellTotal;
    if (rawMove < -TIME_EPSILON) {
      throw new RangeError(
        `Рейс ${trip.id}: между остановками ${from} и ${to} не хватает времени (${rawMove.toFixed(3)} с)`,
      );
    }
    const moveS = Math.max(0, rawMove);

    // Доля каждого промежуточного отрезка по прямому расстоянию.
    const segments: number[] = [];
    let totalDistance = 0;
    for (let index = from + 1; index <= to; index += 1) {
      const previous = stops[index - 1];
      const current = stops[index];
      const distance = previous && current ? stopCallDistanceM(previous, current) : 0;
      segments.push(distance);
      totalDistance += distance;
    }

    let travelled = 0;
    let previousDeparture = fromTime.departureS;
    for (let offset = 1; offset < to - from; offset += 1) {
      const index = from + offset;
      travelled += segments[offset - 1] ?? 0;
      const fraction = totalDistance > TIME_EPSILON ? travelled / totalDistance : offset / (to - from);
      const dwellBefore = dwells.slice(0, offset - 1).reduce((sum, value) => sum + value, 0);
      const rawArrival = fromTime.departureS + moveS * fraction + dwellBefore;
      const latestArrival = Math.max(previousDeparture, Math.floor(toTime.arrivalS));
      let arrival = Math.round(Math.max(rawArrival, previousDeparture));
      arrival = Math.min(arrival, latestArrival);
      const dwell = dwells[offset - 1] ?? 0;
      let departure = arrival + dwell;
      if (departure > toTime.arrivalS) departure = Math.max(arrival, Math.floor(toTime.arrivalS));
      const time = stopTimes[index];
      const seq = time ? time.seq : index;
      result[index] = { seq, arrivalS: arrival, departureS: departure, interpolated: true };
      interpolatedSeqs.push(seq);
      previousDeparture = departure;
    }
  }

  return {
    stopTimes: result,
    complete: trip.complete && interpolatedSeqs.length === 0,
    interpolatedSeqs,
  };
}

/* ------------------------------------------------------------------------- */
/* Класс расписания.                                                         */
/* ------------------------------------------------------------------------- */

/** Проблема, найденная при построении индекса расписания. */
export interface ScheduleIssue {
  /** Идентификатор объекта, к которому относится проблема. */
  subjectId: string;
  /** Вид объекта. */
  subject: 'trip' | 'calendar';
  /** Человекочитаемое описание. */
  message: string;
}

/** Параметры `TripSchedule`. */
export interface TripScheduleOptions {
  /** Рейсы расписания (могут ссылаться на календари). */
  trips: readonly MobilityTrip[];
  /** Календари обслуживания. */
  calendars: readonly MobilityServiceCalendar[];
}

/** Кадр рейса: к какой дате обслуживания он относится и какая сейчас фаза. */
export interface TripFrame {
  /** Дата обслуживания рейса; может быть предыдущей календарной датой. */
  serviceDate: string;
  /** Секунды от начала этого дня обслуживания; после полуночи могут быть > 86400. */
  serviceSeconds: number;
  /** Плановая фаза рейса в этот момент. */
  phase: TripPhase;
}

/** Активный рейс, выбранный из индекса. */
export interface ActiveScheduledTrip extends TripFrame {
  trip: MobilityTrip;
}

function isWithinTripWindow(window: TripTimeWindow, seconds: number): boolean {
  return seconds >= window.firstArrivalS - TIME_EPSILON && seconds <= window.lastDepartureS + TIME_EPSILON;
}

interface ServiceQuery {
  serviceDate: string;
  serviceSeconds: number;
  serviceDayNumber: number;
  previousDate: string;
  previousDayNumber: number;
}

function assertServiceQuery(serviceDate: string, serviceSeconds: number): void {
  if (!isValidIsoDate(serviceDate)) {
    throw new RangeError(`Некорректная дата обслуживания: "${serviceDate}"`);
  }
  if (!Number.isFinite(serviceSeconds) || serviceSeconds < 0 || serviceSeconds >= SECONDS_PER_DAY) {
    throw new RangeError(
      `Секунды дня обслуживания должны быть в [0, ${SECONDS_PER_DAY}), получено: ${serviceSeconds}`,
    );
  }
}

/** Разбирает запрос один раз: календарь и окна рейсов дальше работают по числу суток. */
function createServiceQuery(serviceDate: string, serviceSeconds: number): ServiceQuery {
  assertServiceQuery(serviceDate, serviceSeconds);
  const serviceDayNumber = isoDateToDayNumber(serviceDate);
  const previousDayNumber = serviceDayNumber - 1;
  return {
    serviceDate,
    serviceSeconds,
    serviceDayNumber,
    previousDate: dayNumberToIsoDate(previousDayNumber),
    previousDayNumber,
  };
}

/**
 * Индекс календарей и рейсов для выбора активных рейсов и их плановой фазы.
 *
 * Класс хранит только проверенные рейсы; всё, что не прошло проверку, попадает
 * в `issues` и никогда не активируется (ошибочный рейс не подменяется
 * случайным интервалом). Состояние класса не зависит от браузерного времени:
 * дата и секунды передаются вызывающей стороной (обычно — `SimulationClock`).
 */
export class TripSchedule {
  private readonly calendars = new Map<string, CalendarIndex>();
  private readonly tripsById = new Map<string, MobilityTrip>();
  private readonly calendarByTripId = new Map<string, CalendarIndex>();
  private readonly windowByTripId = new Map<string, TripTimeWindow>();
  private readonly validTrips: MobilityTrip[] = [];
  private readonly issueList: ScheduleIssue[] = [];

  constructor(options: TripScheduleOptions) {
    for (const calendar of options.calendars) {
      if (this.calendars.has(calendar.id)) {
        this.issueList.push({
          subject: 'calendar',
          subjectId: calendar.id,
          message: `календарь ${calendar.id} объявлен повторно`,
        });
        continue;
      }
      try {
        this.calendars.set(calendar.id, buildCalendarIndex(calendar));
      } catch (error) {
        this.issueList.push({
          subject: 'calendar',
          subjectId: calendar.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const trip of options.trips) {
      if (!trip.id || this.tripsById.has(trip.id)) {
        this.issueList.push({
          subject: 'trip',
          subjectId: trip.id,
          message: `рейс ${trip.id} объявлен повторно или без id`,
        });
        continue;
      }
      if (!trip.calendarId) {
        this.issueList.push({
          subject: 'trip',
          subjectId: trip.id,
          message: `рейс ${trip.id}: не задан calendarId`,
        });
        continue;
      }
      const calendar = this.calendars.get(trip.calendarId);
      if (!calendar) {
        this.issueList.push({
          subject: 'trip',
          subjectId: trip.id,
          message: `рейс ${trip.id}: календарь ${trip.calendarId} не найден`,
        });
        continue;
      }
      const timeIssues = tripStopTimeIssues(trip);
      if (timeIssues.length > 0) {
        this.issueList.push({
          subject: 'trip',
          subjectId: trip.id,
          message: timeIssues.join('; '),
        });
        continue;
      }
      this.tripsById.set(trip.id, trip);
      this.calendarByTripId.set(trip.id, calendar);
      this.windowByTripId.set(trip.id, tripTimeWindow(trip));
      this.validTrips.push(trip);
    }
  }

  /** Проблемы данных, найденные при построении индекса. */
  get issues(): readonly ScheduleIssue[] {
    return this.issueList;
  }

  /** Проверенные рейсы в порядке входного массива. */
  get trips(): readonly MobilityTrip[] {
    return this.validTrips;
  }

  /**
   * Работает ли календарь в дату. Неизвестный календарь — `false`.
   *
   * @throws RangeError на некорректной ISO-дате.
   */
  calendarActive(calendarId: string, isoDate: string): boolean {
    const dayNumber = isoDateToDayNumber(isoDate);
    const calendar = this.calendars.get(calendarId);
    if (!calendar) return false;
    return calendarIndexActiveOnDay(calendar, isoDate, dayNumber);
  }

  /** Запланирован ли рейс на дату (рейс известен и его календарь активен). */
  isTripScheduled(tripId: string, isoDate: string): boolean {
    const dayNumber = isoDateToDayNumber(isoDate);
    const calendar = this.calendarByTripId.get(tripId);
    if (!calendar) return false;
    return calendarIndexActiveOnDay(calendar, isoDate, dayNumber);
  }

  /**
   * Рейсы, назначенные на дату обслуживания (без учёта текущего времени).
   *
   * Это счётчик «рейсов на день» для статуса UI: в отличие от `activeTrips()`
   * сюда входят и рейсы, которые ещё не начались или уже закончились, но
   * относятся именно к этой дате. Порядок — порядок входного массива.
   *
   * @throws RangeError на некорректной ISO-дате.
   */
  scheduledTrips(isoDate: string): MobilityTrip[] {
    const dayNumber = isoDateToDayNumber(isoDate);
    const result: MobilityTrip[] = [];
    for (const trip of this.validTrips) {
      const calendar = this.calendarByTripId.get(trip.id);
      if (calendar && calendarIndexActiveOnDay(calendar, isoDate, dayNumber)) result.push(trip);
    }
    return result;
  }

  /**
   * Кадр рейса на момент `serviceSeconds` даты `serviceDate`.
   *
   * Возвращает `null`, если рейс неизвестен или его календарь не работает ни на
   * запрошенную дату, ни на предыдущую (для рейсов после полуночи). Для рейса,
   * который сегодня уже завершён или ещё не начался, возвращается фаза
   * `after-end` / `before-start` — это позволяет планировать его появление.
   *
   * @throws RangeError на некорректных дате или секундах.
   */
  tripFrame(tripId: string, serviceDate: string, serviceSeconds: number): TripFrame | null {
    const query = createServiceQuery(serviceDate, serviceSeconds);
    const trip = this.tripsById.get(tripId);
    if (!trip) return null;
    return this.resolveTripFrame(trip, query);
  }

  /**
   * Все рейсы, которые идут в указанный момент (включая стоянки).
   *
   * Учитываются рейсы текущей даты и рейсы предыдущего дня с временами
   * `> 86400` (после полуночи). Порядок детерминирован: дата обслуживания, затем
   * id рейса.
   *
   * @throws RangeError на некорректных дате или секундах.
   */
  activeTrips(serviceDate: string, serviceSeconds: number): ActiveScheduledTrip[] {
    const query = createServiceQuery(serviceDate, serviceSeconds);
    const active: ActiveScheduledTrip[] = [];
    for (const trip of this.validTrips) {
      const frame = this.resolveTripFrame(trip, query);
      if (!frame) continue;
      if (frame.phase.kind !== 'at-stop' && frame.phase.kind !== 'between-stops') continue;
      active.push({ trip, ...frame });
    }
    active.sort((left, right) => {
      if (left.serviceDate !== right.serviceDate) {
        return left.serviceDate < right.serviceDate ? -1 : 1;
      }
      if (left.trip.id === right.trip.id) return 0;
      return left.trip.id < right.trip.id ? -1 : 1;
    });
    return active;
  }

  /**
   * Прогноз прибытия на остановку с учётом накопленной задержки.
   * Неизвестный рейс или индекс — `null`.
   */
  forecastArrival(tripId: string, stopIndex: number, delayS: number): number | null {
    const trip = this.tripsById.get(tripId);
    if (!trip) return null;
    if (!Number.isInteger(stopIndex) || stopIndex < 0 || stopIndex >= trip.stopTimes.length) {
      return null;
    }
    return forecastArrivalS(trip, stopIndex, delayS);
  }

  private resolveTripFrame(trip: MobilityTrip, query: ServiceQuery): TripFrame | null {
    const calendar = this.calendarByTripId.get(trip.id);
    const window = this.windowByTripId.get(trip.id);
    if (!calendar || !window) return null;

    // Сначала проверяем предыдущий день обслуживания: именно он продолжается
    // после полуночи, если рейс получил времена > 86400.
    const previousSeconds = query.serviceSeconds + SECONDS_PER_DAY;
    if (
      calendarIndexActiveOnDay(calendar, query.previousDate, query.previousDayNumber) &&
      isWithinTripWindow(window, previousSeconds)
    ) {
      return {
        serviceDate: query.previousDate,
        serviceSeconds: previousSeconds,
        phase: tripPhaseAt(trip, previousSeconds),
      };
    }
    if (!calendarIndexActiveOnDay(calendar, query.serviceDate, query.serviceDayNumber)) return null;
    return {
      serviceDate: query.serviceDate,
      serviceSeconds: query.serviceSeconds,
      phase: tripPhaseAt(trip, query.serviceSeconds),
    };
  }
}
