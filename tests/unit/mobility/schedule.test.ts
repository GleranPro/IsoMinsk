/**
 * Тесты календаря обслуживания, плановой фазы рейса, интерполяции неполного
 * рейса, прогноза задержки и независимости от часового пояса браузера.
 */

import { describe, expect, it } from 'vitest';
import { SimulationClock } from '../../../src/mobility/clock';
import {
  SECONDS_PER_DAY,
  TripSchedule,
  addIsoDays,
  calendarActiveOn,
  compareIsoDates,
  dayNumberToIsoDate,
  forecastArrivalS,
  interpolateTripTimes,
  isValidIsoDate,
  isoDateToDayNumber,
  isoWeekday,
  tripActiveAt,
  tripPhaseAt,
  tripStopTimeIssues,
  tripTimeWindow,
} from '../../../src/mobility/schedule';
import type {
  MobilityRouteVariant,
  MobilityServiceCalendar,
  MobilityStopCall,
  MobilityStopTime,
  MobilityTrip,
} from '../../../src/shared/mobility';

function calendar(overrides: Partial<MobilityServiceCalendar> = {}): MobilityServiceCalendar {
  return {
    id: 'cal:weekday',
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    weekdays: [1, 2, 3, 4, 5],
    timeZone: 'Europe/Minsk',
    ...overrides,
  };
}

function stop(seq: number, arrivalS: number, departureS: number): MobilityStopTime {
  return { seq, arrivalS, departureS };
}

function trip(
  id: string,
  stopTimes: MobilityStopTime[],
  overrides: Partial<MobilityTrip> = {},
): MobilityTrip {
  return {
    id,
    variantId: 'r:test:0:1',
    calendarId: 'cal:weekday',
    stopTimes,
    complete: true,
    ...overrides,
  };
}

/** Рейс 08:00 → 09:00 с двумя промежуточными остановками. */
function dailyTrip(id: string): MobilityTrip {
  return trip(id, [stop(0, 28800, 28920), stop(1, 29400, 29460), stop(2, 30000, 30000)]);
}

function stopCall(seq: number, x: number, dwellS: number, timed: boolean): MobilityStopCall {
  return {
    seq,
    stopId: `s:${seq}`,
    edgeId: 'e:1:f',
    laneIndex: 0,
    s: x,
    heading: 0,
    x,
    y: 0,
    h: 0,
    dwellS,
    timed,
    binding: 'source-id',
  };
}

function variantWith(stops: MobilityStopCall[], overrides: Partial<MobilityRouteVariant> = {}): MobilityRouteVariant {
  return {
    id: 'r:test:0:1',
    mode: 'bus',
    ref: '1',
    headSign: 'Тест',
    direction: 0,
    edges: [],
    stops,
    lengthM: 800,
    sourceRelationId: 1,
    verified: true,
    bounds: [0, 0, 0, 0],
    ...overrides,
  };
}

describe('schedule — ISO-даты без Date-ловушек', () => {
  it('проверяет строгий формат и реальность даты', () => {
    expect(isValidIsoDate('2026-11-16')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-11-31')).toBe(false);
    expect(isValidIsoDate('2026-1-1')).toBe(false);
    expect(isValidIsoDate('2026-11-16T00:00:00Z')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });

  it('нумерует сутки от 1970-01-01 и возвращает день недели', () => {
    expect(isoDateToDayNumber('1970-01-01')).toBe(0);
    expect(isoWeekday('1970-01-01')).toBe(4); // четверг
    expect(isoWeekday('2026-11-16')).toBe(1); // понедельник
    expect(isoWeekday('2026-11-21')).toBe(6); // суббота
    expect(isoWeekday('2026-11-22')).toBe(0); // воскресенье
    expect(dayNumberToIsoDate(0)).toBe('1970-01-01');
  });

  it('переходит месяцы, годы и високосные дни', () => {
    expect(addIsoDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addIsoDays('2026-11-16', -1)).toBe('2026-11-15');
    expect(addIsoDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addIsoDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addIsoDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(compareIsoDates('2026-11-16', '2026-11-17')).toBe(-1);
    expect(compareIsoDates('2026-11-16', '2026-11-16')).toBe(0);
    expect(compareIsoDates('2026-12-01', '2026-11-30')).toBe(1);
    expect(() => addIsoDays('2026-11-16', 0.5)).toThrow(RangeError);
    expect(() => isoDateToDayNumber('2026-11-31')).toThrow(RangeError);
  });
});

describe('schedule — календарь обслуживания', () => {
  it('учитывает период действия и дни недели', () => {
    const weekdays = calendar();
    expect(calendarActiveOn(weekdays, '2026-11-16')).toBe(true); // понедельник
    expect(calendarActiveOn(weekdays, '2026-11-20')).toBe(true); // пятница
    expect(calendarActiveOn(weekdays, '2026-11-21')).toBe(false); // суббота
    expect(calendarActiveOn(weekdays, '2026-10-31')).toBe(false); // до периода
    expect(calendarActiveOn(weekdays, '2026-12-01')).toBe(false); // после периода
  });

  it('исключения add/remove перекрывают дни недели', () => {
    const withExceptions = calendar({
      exceptions: [
        { date: '2026-11-16', kind: 'remove' },
        { date: '2026-11-22', kind: 'add' },
      ],
    });
    expect(calendarActiveOn(withExceptions, '2026-11-16')).toBe(false);
    expect(calendarActiveOn(withExceptions, '2026-11-22')).toBe(true); // воскресенье добавлено
    expect(calendarActiveOn(withExceptions, '2026-11-23')).toBe(true);
  });

  it('add не расширяет период действия календаря', () => {
    const withAdd = calendar({ exceptions: [{ date: '2026-12-25', kind: 'add' }] });
    expect(calendarActiveOn(withAdd, '2026-12-25')).toBe(false);
  });

  it('отвергает противоречивые календари', () => {
    expect(() =>
      calendarActiveOn(
        calendar({
          exceptions: [
            { date: '2026-11-16', kind: 'add' },
            { date: '2026-11-16', kind: 'remove' },
          ],
        }),
        '2026-11-16',
      ),
    ).toThrow(RangeError);
    expect(() => calendarActiveOn(calendar({ weekdays: [7] }), '2026-11-16')).toThrow(RangeError);
    expect(() =>
      calendarActiveOn(calendar({ startDate: '2026-12-01', endDate: '2026-11-01' }), '2026-11-16'),
    ).toThrow(RangeError);
  });
});

describe('schedule — плановая фаза и времена остановок', () => {
  const sample = dailyTrip('t:sample');

  it('различает до старта, стоянку, перегон и конец', () => {
    const before = tripPhaseAt(sample, 28000);
    expect(before.kind).toBe('before-start');
    expect(before.elapsedS).toBe(-800);

    const atFirst = tripPhaseAt(sample, 28850);
    expect(atFirst.kind).toBe('at-stop');
    expect(atFirst.stopIndex).toBe(0);
    expect(atFirst.progress).toBeCloseTo(50 / 120, 9);

    const between = tripPhaseAt(sample, 29100);
    expect(between.kind).toBe('between-stops');
    expect(between.fromIndex).toBe(0);
    expect(between.toIndex).toBe(1);
    expect(between.progress).toBeCloseTo(180 / 480, 9);

    const atSecond = tripPhaseAt(sample, 29430);
    expect(atSecond.kind).toBe('at-stop');
    expect(atSecond.stopIndex).toBe(1);
    expect(atSecond.progress).toBeCloseTo(0.5, 9);

    const beforeEnd = tripPhaseAt(sample, 29700);
    expect(beforeEnd.kind).toBe('between-stops');
    expect(beforeEnd.progress).toBeCloseTo(240 / 540, 9);

    const after = tripPhaseAt(sample, 30100);
    expect(after.kind).toBe('after-end');
    expect(after.elapsedS).toBe(100);
    expect(after.progress).toBe(1);
  });

  it('границы фаз детерминированы', () => {
    expect(tripPhaseAt(sample, 28800).kind).toBe('at-stop');
    expect(tripPhaseAt(sample, 28920).kind).toBe('at-stop');
    expect(tripPhaseAt(sample, 28920.5).kind).toBe('between-stops');
    expect(tripPhaseAt(sample, 29400).kind).toBe('at-stop');
    expect(tripPhaseAt(sample, 30000).kind).toBe('at-stop');
    expect(tripPhaseAt(sample, 30001).kind).toBe('after-end');
    expect(tripActiveAt(sample, 28799)).toBe(false);
    expect(tripActiveAt(sample, 28800)).toBe(true);
    expect(tripActiveAt(sample, 30000)).toBe(true);
    expect(tripActiveAt(sample, 30001)).toBe(false);
  });

  it('временной диапазон и проверка времён', () => {
    expect(tripTimeWindow(sample)).toEqual({
      firstArrivalS: 28800,
      firstDepartureS: 28920,
      lastArrivalS: 30000,
      lastDepartureS: 30000,
    });
    expect(tripStopTimeIssues(sample)).toEqual([]);
    const broken = trip('t:broken', [stop(0, 29000, 29000), stop(2, 28000, 28000)]);
    const issues = tripStopTimeIssues(broken);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(' ')).toContain('seq');
    const nonMonotone = trip('t:nonmonotone', [stop(0, 30000, 30000), stop(1, 29000, 29000)]);
    expect(tripStopTimeIssues(nonMonotone).length).toBeGreaterThan(0);
    const fractional = trip('t:fractional', [stop(0, 28800.5, 28800.5)]);
    expect(tripStopTimeIssues(fractional).length).toBeGreaterThan(0);
    expect(() => tripPhaseAt(trip('t:empty', []), 0)).toThrow(RangeError);
  });

  it('прогноз прибытия учитывает только положительную задержку', () => {
    expect(forecastArrivalS(sample, 1, 120)).toBe(29520);
    expect(forecastArrivalS(sample, 1, -60)).toBe(29400);
    expect(() => forecastArrivalS(sample, 5, 0)).toThrow(RangeError);
  });
});

describe('schedule — активные рейсы и класс TripSchedule', () => {
  it('выбирает только идущие рейсы даты обслуживания', () => {
    const schedule = new TripSchedule({
      calendars: [calendar()],
      trips: [
        dailyTrip('t:a'),
        trip('t:b', [stop(0, 32400, 32400), stop(1, 33000, 33000)]),
      ],
    });
    expect(schedule.issues).toEqual([]);
    const active = schedule.activeTrips('2026-11-16', 29000);
    expect(active).toHaveLength(1);
    expect(active[0]?.trip.id).toBe('t:a');
    expect(active[0]?.serviceDate).toBe('2026-11-16');
    expect(active[0]?.serviceSeconds).toBe(29000);
    expect(active[0]?.phase.kind).toBe('between-stops');

    expect(schedule.activeTrips('2026-11-16', 31000)).toHaveLength(0);
    const second = schedule.activeTrips('2026-11-16', 32450);
    expect(second).toHaveLength(1);
    expect(second[0]?.trip.id).toBe('t:b');
    expect(second[0]?.phase.kind).toBe('between-stops');

    // Выходной день: календарь не работает.
    expect(schedule.activeTrips('2026-11-22', 29000)).toHaveLength(0);
    expect(schedule.isTripScheduled('t:a', '2026-11-22')).toBe(false);
    expect(schedule.isTripScheduled('t:a', '2026-11-16')).toBe(true);
    expect(schedule.isTripScheduled('t:unknown', '2026-11-16')).toBe(false);
    expect(schedule.scheduledTrips('2026-11-16').map((item) => item.id)).toEqual(['t:a', 't:b']);
    expect(schedule.scheduledTrips('2026-11-22')).toHaveLength(0);
    expect(() => schedule.scheduledTrips('16.11.2026')).toThrow(RangeError);
  });

  it('возвращает before-start/after-end вне окна рейса', () => {
    const schedule = new TripSchedule({ calendars: [calendar()], trips: [dailyTrip('t:a')] });
    expect(schedule.tripFrame('t:a', '2026-11-16', 28000)?.phase.kind).toBe('before-start');
    expect(schedule.tripFrame('t:a', '2026-11-16', 31000)?.phase.kind).toBe('after-end');
    expect(schedule.tripFrame('t:a', '2026-11-16', 29000)?.phase.kind).toBe('between-stops');
    expect(schedule.tripFrame('t:unknown', '2026-11-16', 29000)).toBeNull();
    expect(() => schedule.activeTrips('16.11.2026', 0)).toThrow(RangeError);
    expect(() => schedule.activeTrips('2026-11-16', SECONDS_PER_DAY)).toThrow(RangeError);
  });

  it('рейс после полуночи продолжает предыдущий день обслуживания', () => {
    const late = trip('t:late', [stop(0, 85500, 85500), stop(1, 87000, 87000)]);
    const schedule = new TripSchedule({
      calendars: [calendar({ weekdays: [0, 1, 2, 3, 4, 5, 6] })],
      trips: [late],
    });
    const active = schedule.activeTrips('2026-11-17', 300);
    expect(active).toHaveLength(1);
    expect(active[0]?.serviceDate).toBe('2026-11-16');
    expect(active[0]?.serviceSeconds).toBe(86700);
    expect(active[0]?.phase.kind).toBe('between-stops');
    expect(active[0]?.phase.progress).toBeCloseTo(0.8, 9);
    expect(active[0]?.phase.fromIndex).toBe(0);
    expect(active[0]?.phase.toIndex).toBe(1);

    // 00:20 — рейс уже завершён; фаза относится к сегодняшнему дню (до старта).
    expect(schedule.activeTrips('2026-11-17', 20 * 60)).toHaveLength(0);
    const frame = schedule.tripFrame('t:late', '2026-11-17', 20 * 60);
    expect(frame?.serviceDate).toBe('2026-11-17');
    expect(frame?.phase.kind).toBe('before-start');

    // На следующий день в 02:30 тот же рейс ещё не начался (старт в 23:45).
    expect(schedule.tripFrame('t:late', '2026-11-17', 2.5 * 3600)?.phase.kind).toBe('before-start');
  });

  it('помечает ошибочные рейсы в issues и не активирует их', () => {
    const schedule = new TripSchedule({
      calendars: [calendar()],
      trips: [
        dailyTrip('t:ok'),
        trip('t:bad', [stop(0, 30000, 30000), stop(1, 29000, 29000)]),
        trip('t:no-calendar', [stop(0, 28800, 28800)], { calendarId: 'cal:missing' }),
      ],
    });
    expect(schedule.trips.map((item) => item.id)).toEqual(['t:ok']);
    expect(schedule.issues.length).toBe(2);
    expect(schedule.issues.map((issue) => issue.subjectId).sort()).toEqual([
      't:bad',
      't:no-calendar',
    ]);
    expect(schedule.activeTrips('2026-11-16', 29000)).toHaveLength(1);
  });

  it('прогноз прибытия класса соответствует чистой функции', () => {
    const sample = dailyTrip('t:a');
    const schedule = new TripSchedule({ calendars: [calendar()], trips: [sample] });
    expect(schedule.forecastArrival('t:a', 2, 45)).toBe(30045);
    expect(schedule.forecastArrival('t:a', 2, -45)).toBe(30000);
    expect(schedule.forecastArrival('t:a', 9, 0)).toBeNull();
    expect(schedule.forecastArrival('t:unknown', 0, 0)).toBeNull();
  });
});

describe('schedule — независимость от часового пояса браузера', () => {
  it('одно мгновение даёт разные наборы активных рейсов в разных зонах', () => {
    // Субботний рейс 01:00–03:00 (в зоне расписания).
    const saturdayTrip = trip('t:sat', [stop(0, 3600, 3600), stop(1, 10800, 10800)]);
    const schedule = new TripSchedule({
      calendars: [calendar({ weekdays: [6] })],
      trips: [saturdayTrip],
    });
    const instant = Date.UTC(2026, 10, 20, 23, 30, 0); // пятница 18:30 Нью-Йорк / суббота 02:30 Минск

    const minsk = new SimulationClock({ nowMs: instant, timeZone: 'Europe/Minsk' });
    expect(minsk.serviceDate).toBe('2026-11-21');
    expect(schedule.activeTrips(minsk.serviceDate, minsk.serviceSeconds)).toHaveLength(1);

    const newYork = new SimulationClock({ nowMs: instant, timeZone: 'America/New_York' });
    expect(newYork.serviceDate).toBe('2026-11-20');
    expect(schedule.activeTrips(newYork.serviceDate, newYork.serviceSeconds)).toHaveLength(0);
  });
});

describe('schedule — интерполяция неполного рейса', () => {
  const stops = [
    stopCall(0, 0, 60, true),
    stopCall(1, 200, 30, false),
    stopCall(2, 400, 30, false),
    stopCall(3, 600, 30, false),
    stopCall(4, 800, 0, true),
  ];
  const variant = variantWith(stops);
  const partial = trip('t:partial', [
    stop(0, 28800, 28920),
    stop(1, 29000, 29000),
    stop(2, 29500, 29500),
    stop(3, 30000, 30000),
    stop(4, 30120, 30120),
  ]);

  it('распределяет время пропорционально расстоянию и явно помечает значения', () => {
    const timetable = interpolateTripTimes(variant, partial);
    expect(timetable.complete).toBe(false);
    expect(timetable.interpolatedSeqs).toEqual([1, 2, 3]);
    expect(timetable.stopTimes[0]).toEqual({
      seq: 0,
      arrivalS: 28800,
      departureS: 28920,
      interpolated: false,
    });
    expect(timetable.stopTimes[4]).toEqual({
      seq: 4,
      arrivalS: 30120,
      departureS: 30120,
      interpolated: false,
    });
    expect(timetable.stopTimes[1]?.interpolated).toBe(true);
    expect(timetable.stopTimes[1]?.arrivalS).toBe(29198);
    expect(timetable.stopTimes[1]?.departureS).toBe(29228);
    expect(timetable.stopTimes[2]?.arrivalS).toBe(29505);
    expect(timetable.stopTimes[2]?.departureS).toBe(29535);
    expect(timetable.stopTimes[3]?.arrivalS).toBe(29813);
    expect(timetable.stopTimes[3]?.departureS).toBe(29843);
    for (let index = 1; index < timetable.stopTimes.length; index += 1) {
      const previous = timetable.stopTimes[index - 1];
      const current = timetable.stopTimes[index];
      expect(current?.arrivalS).toBeGreaterThanOrEqual(previous?.departureS ?? 0);
      expect(current?.arrivalS).toBeLessThanOrEqual(30120);
    }
    // Модель детерминирована: повторный вызов даёт тот же результат.
    expect(interpolateTripTimes(variant, partial)).toEqual(timetable);
  });

  it('полный рейс не интерполируется и сохраняет времена источника', () => {
    const fullVariant = variantWith(stops.map((call) => ({ ...call, timed: true })));
    const completeTrip = trip('t:full', [
      stop(0, 28800, 28860),
      stop(1, 29100, 29130),
      stop(2, 29400, 29430),
      stop(3, 29700, 29730),
      stop(4, 30000, 30000),
    ]);
    const timetable = interpolateTripTimes(fullVariant, completeTrip);
    expect(timetable.complete).toBe(true);
    expect(timetable.interpolatedSeqs).toEqual([]);
    expect(timetable.stopTimes.map((time) => time.arrivalS)).toEqual([
      28800, 29100, 29400, 29700, 30000,
    ]);
  });

  it('использует fallbackDwellS для промежуточных остановок без стоянки', () => {
    const fallbackVariant = variantWith([
      stopCall(0, 0, 0, true),
      stopCall(1, 100, Number.NaN, false),
      stopCall(2, 200, 0, true),
    ]);
    const fallbackTrip = trip('t:fallback', [
      stop(0, 28800, 28800),
      stop(1, 29000, 29000),
      stop(2, 29200, 29200),
    ]);
    const timetable = interpolateTripTimes(fallbackVariant, fallbackTrip, { fallbackDwellS: 20 });
    expect(timetable.interpolatedSeqs).toEqual([1]);
    expect(timetable.stopTimes[1]?.arrivalS).toBe(28990);
    expect(timetable.stopTimes[1]?.departureS).toBe(29010);
  });

  it('отвергает невозможные и несогласованные данные', () => {
    expect(() => interpolateTripTimes(variant, partial, { fallbackDwellS: -1 })).toThrow(RangeError);
    const wrongLength = trip('t:short', [stop(0, 28800, 28920), stop(1, 30120, 30120)]);
    expect(() => interpolateTripTimes(variant, wrongLength)).toThrow(RangeError);
    const impossibleVariant = variantWith([
      stopCall(0, 0, 0, true),
      stopCall(1, 100, 1000, false),
      stopCall(2, 200, 0, true),
    ]);
    const impossible = trip('t:impossible', [
      stop(0, 30000, 30000),
      stop(1, 30100, 30100),
      stop(2, 30500, 30500),
    ]);
    expect(() => interpolateTripTimes(impossibleVariant, impossible)).toThrow(RangeError);
  });
});
