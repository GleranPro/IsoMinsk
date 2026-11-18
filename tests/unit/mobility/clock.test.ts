/**
 * Тесты единых часов симуляции: фиксированный шаг, догоняющий лимит, пауза,
 * alpha-интерполяция, независимость от часового пояса браузера, seed.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CATCH_UP_STEPS,
  DEFAULT_STEP_HZ,
  SimulationClock,
  civilDateTimeToEpochMs,
} from '../../../src/mobility/clock';
import type { SimulationClockOptions } from '../../../src/mobility/clock';
import { TripSchedule } from '../../../src/mobility/schedule';
import { SignalController } from '../../../src/mobility/signals';
import type {
  MobilityServiceCalendar,
  MobilitySignalNode,
  MobilityTrip,
} from '../../../src/shared/mobility';

/** Часы QA-сценария 16.11.2026 08:00 Europe/Minsk с большим догоняющим лимитом. */
function qaClock(options: SimulationClockOptions = {}): SimulationClock {
  return new SimulationClock({
    fixedDate: '2026-11-16',
    fixedTimeSeconds: 8 * 3600,
    maxCatchUpSteps: 64,
    ...options,
  });
}

/** Прогон заданного числа секунд кадрами с частотой `fps`; один вызов `random()` на шаг. */
function runAtFps(fps: number, seconds: number): { steps: number; draws: number[]; clock: SimulationClock } {
  const clock = qaClock({ seed: 99 });
  const draws: number[] = [];
  let steps = 0;
  const frames = Math.round(seconds * fps);
  for (let frame = 0; frame < frames; frame += 1) {
    const produced = clock.advance(1 / fps);
    steps += produced;
    for (let step = 0; step < produced; step += 1) draws.push(clock.random());
  }
  return { steps, draws, clock };
}

describe('SimulationClock — шаг, догоняющий лимит, alpha', () => {
  it('по умолчанию работает на 10 Гц и стартует в живом режиме', () => {
    const clock = new SimulationClock({
      nowMs: Date.UTC(2026, 10, 16, 6, 0, 0),
      timeZone: 'Europe/Minsk',
    });
    expect(clock.stepHz).toBe(DEFAULT_STEP_HZ);
    expect(clock.stepSeconds).toBeCloseTo(0.1, 12);
    expect(clock.maxCatchUpSteps).toBe(DEFAULT_MAX_CATCH_UP_STEPS);
    expect(clock.isLive).toBe(true);
    expect(clock.fixedDate).toBeNull();
    expect(clock.serviceDate).toBe('2026-11-16');
    expect(clock.serviceSeconds).toBe(9 * 3600);
  });

  it('фиксированная дата/время QA задаёт точку отсчёта без Date-ловушек', () => {
    const clock = new SimulationClock({
      fixedDate: '2026-11-16',
      fixedTimeSeconds: 8 * 3600,
      timeZone: 'Europe/Minsk',
    });
    expect(clock.fixedDate).toBe('2026-11-16');
    expect(clock.fixedTimeSeconds).toBe(28800);
    expect(clock.serviceDate).toBe('2026-11-16');
    expect(clock.serviceSeconds).toBe(28800);
    expect(clock.serviceSecondsExact).toBe(28800);
    expect(clock.epochMs).toBe(Date.UTC(2026, 10, 16, 5, 0, 0));
    expect(clock.alpha).toBe(0);
    expect(clock.stepCount).toBe(0);
  });

  it('advance выполняет целое число фиксированных шагов', () => {
    const clock = qaClock();
    expect(clock.advance(1)).toBe(10);
    expect(clock.stepCount).toBe(10);
    expect(clock.simulatedSeconds).toBeCloseTo(1, 9);
    expect(clock.serviceSeconds).toBe(28801);
    expect(clock.advance(0.25)).toBe(2);
    expect(clock.stepCount).toBe(12);
    expect(clock.serviceSeconds).toBe(28801);
  });

  it('alpha — доля незавершённого шага и не выходит за [0, 1]', () => {
    const clock = qaClock();
    expect(clock.advance(0.04)).toBe(0);
    expect(clock.alpha).toBeCloseTo(0.4, 9);
    expect(clock.advance(0.06)).toBe(1);
    expect(clock.alpha).toBeCloseTo(0, 6);
    clock.advance(2.345);
    expect(clock.alpha).toBeGreaterThanOrEqual(0);
    expect(clock.alpha).toBeLessThan(1);
  });

  it('нечисловые и отрицательные дельты игнорируются', () => {
    const clock = qaClock();
    expect(clock.advance(Number.NaN)).toBe(0);
    expect(clock.advance(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clock.advance(-1)).toBe(0);
    expect(clock.stepCount).toBe(0);
  });

  it('длинный кадр не запускает длинный догоняющий расчёт', () => {
    const clock = qaClock({ maxCatchUpSteps: 5 });
    expect(clock.advance(60)).toBe(5);
    expect(clock.stepCount).toBe(5);
    expect(clock.simulatedSeconds).toBeCloseTo(0.5, 9);
    expect(clock.serviceSeconds).toBe(28800);
    // Отброшенное время не копится: следующий кадр начинается с чистого листа.
    expect(clock.advance(0.1)).toBe(1);
    expect(clock.stepCount).toBe(6);
  });

  it('скрытая вкладка не приводит к бесконечному догону', () => {
    const clock = qaClock({ maxCatchUpSteps: 4 });
    expect(clock.advance(5 * 60)).toBe(4);
    expect(clock.simulatedSeconds).toBeCloseTo(0.4, 9);
  });

  it('одинаковый seed и разный render FPS дают одинаковое состояние', () => {
    const sixty = runAtFps(60, 5);
    const thirty = runAtFps(30, 5);
    const oneFortyFour = runAtFps(144, 5);
    for (const run of [sixty, thirty, oneFortyFour]) {
      expect(run.steps).toBe(50);
      expect(run.clock.stepCount).toBe(50);
      expect(run.clock.serviceSeconds).toBe(28805);
      expect(run.draws).toHaveLength(50);
    }
    expect(sixty.draws).toEqual(thirty.draws);
    expect(sixty.draws).toEqual(oneFortyFour.draws);
    expect(sixty.clock.serviceSecondsExact).toBeCloseTo(28805, 6);
  });

  it('пауза не копит время и сбрасывает неполный шаг', () => {
    const clock = qaClock();
    expect(clock.advance(0.05)).toBe(0);
    clock.pause();
    expect(clock.paused).toBe(true);
    expect(clock.alpha).toBe(0);
    expect(clock.advance(30)).toBe(0);
    expect(clock.stepCount).toBe(0);
    clock.resume();
    expect(clock.paused).toBe(false);
    expect(clock.advance(0.05)).toBe(0);
    expect(clock.advance(0.05)).toBe(1);
    expect(clock.stepCount).toBe(1);
  });

  it('setPaused и явный step() для QA', () => {
    const clock = qaClock({ paused: true });
    expect(clock.advance(1)).toBe(0);
    expect(clock.step(3)).toBe(3);
    expect(clock.stepCount).toBe(3);
    expect(clock.serviceSeconds).toBe(28800);
    clock.step(10);
    expect(clock.stepCount).toBe(13);
    expect(clock.serviceSeconds).toBe(28801);
    expect(() => clock.step(-1)).toThrow(RangeError);
    expect(() => clock.step(1.5)).toThrow(RangeError);

    clock.paused = false;
    expect(clock.paused).toBe(false);
    clock.paused = true;
    expect(clock.paused).toBe(true);
    expect(clock.advance(10)).toBe(0);
  });

  it('переход через полночь меняет дату обслуживания', () => {
    const clock = new SimulationClock({
      fixedDate: '2026-11-16',
      fixedTimeSeconds: 23 * 3600 + 59 * 60 + 59,
      maxCatchUpSteps: 64,
    });
    expect(clock.serviceDate).toBe('2026-11-16');
    expect(clock.serviceSeconds).toBe(86399);
    expect(clock.advance(2)).toBe(20);
    expect(clock.serviceDate).toBe('2026-11-17');
    expect(clock.serviceSeconds).toBe(1);
  });
});

describe('SimulationClock — часовой пояс расписания, а не браузера', () => {
  const instant = Date.UTC(2026, 10, 16, 22, 30, 0);

  it('одно и то же мгновение даёт разные местные даты в разных IANA-зонах', () => {
    const minsk = new SimulationClock({ nowMs: instant, timeZone: 'Europe/Minsk' });
    expect(minsk.serviceDate).toBe('2026-11-17');
    expect(minsk.serviceSeconds).toBe(1 * 3600 + 30 * 60);

    const utc = new SimulationClock({ nowMs: instant, timeZone: 'UTC' });
    expect(utc.serviceDate).toBe('2026-11-16');
    expect(utc.serviceSeconds).toBe(22 * 3600 + 30 * 60);

    const newYork = new SimulationClock({ nowMs: instant, timeZone: 'America/New_York' });
    expect(newYork.serviceDate).toBe('2026-11-16');
    expect(newYork.serviceSeconds).toBe(17 * 3600 + 30 * 60);
  });

  it('учитывает летнее время в зоне расписания', () => {
    const newYork = new SimulationClock({
      nowMs: Date.UTC(2026, 6, 1, 4, 30, 0),
      timeZone: 'America/New_York',
    });
    expect(newYork.serviceDate).toBe('2026-07-01');
    expect(newYork.serviceSeconds).toBe(30 * 60);
  });

  it('fixedDate переводится в UTC через зону расписания', () => {
    const newYork = new SimulationClock({
      fixedDate: '2026-11-16',
      fixedTimeSeconds: 0,
      timeZone: 'America/New_York',
    });
    expect(newYork.epochMs).toBe(Date.UTC(2026, 10, 16, 5, 0, 0));
  });

  it('civilDateTimeToEpochMs согласован с Intl', () => {
    expect(civilDateTimeToEpochMs(2026, 11, 16, 8, 0, 0, 'Europe/Minsk')).toBe(
      Date.UTC(2026, 10, 16, 5, 0, 0),
    );
    expect(civilDateTimeToEpochMs(2026, 11, 16, 8, 0, 0, 'UTC')).toBe(
      Date.UTC(2026, 10, 16, 8, 0, 0),
    );
    expect(civilDateTimeToEpochMs(2026, 5, 10, 12, 0, 0, 'America/New_York')).toBe(
      Date.UTC(2026, 4, 10, 16, 0, 0),
    );
  });

  it('некорректные часы/зоны отвергаются', () => {
    expect(() => new SimulationClock({ timeZone: 'Mars/Olympus' })).toThrow(RangeError);
    expect(() => new SimulationClock({ timeZone: '' })).toThrow(RangeError);
    expect(() => civilDateTimeToEpochMs(2026, 2, 30, 0, 0, 0, 'Europe/Minsk')).toThrow(RangeError);
    expect(() => civilDateTimeToEpochMs(2026, 11, 16, 24, 0, 0, 'Europe/Minsk')).toThrow(RangeError);
  });
});

describe('SimulationClock — seed и явная переинициализация', () => {
  it('детерминированный генератор воспроизводится по seed', () => {
    const first = qaClock({ seed: 42 });
    const second = qaClock({ seed: 42 });
    const other = qaClock({ seed: 43 });
    const sequence = Array.from({ length: 8 }, () => first.random());
    expect(sequence).toEqual(Array.from({ length: 8 }, () => second.random()));
    expect(sequence).not.toEqual(Array.from({ length: 8 }, () => other.random()));
    for (const value of sequence) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    first.resetRandom();
    expect(first.random()).toBe(sequence[0]);
  });

  it('reseed меняет последовательность и сбрасывает генератор', () => {
    const clock = qaClock({ seed: 1 });
    clock.reseed(7);
    expect(clock.seed).toBe(7);
    const first = clock.random();
    clock.resetRandom();
    expect(clock.random()).toBe(first);
  });

  it('setFixedDateTime переинициализирует прогон, сохраняя паузу', () => {
    const clock = qaClock();
    clock.advance(2);
    clock.pause();
    clock.setFixedDateTime('2027-01-01', 12 * 3600);
    expect(clock.serviceDate).toBe('2027-01-01');
    expect(clock.serviceSeconds).toBe(12 * 3600);
    expect(clock.stepCount).toBe(0);
    expect(clock.paused).toBe(true);
    clock.step(5);
    expect(clock.stepCount).toBe(5);
    clock.setFixedDateTime(null);
    expect(clock.isLive).toBe(true);
    expect(clock.fixedDate).toBeNull();
    expect(clock.stepCount).toBe(0);
  });

  it('resetToNow возвращает живые часы от заданного мгновения', () => {
    const clock = qaClock();
    clock.resetToNow(Date.UTC(2026, 10, 16, 18, 0, 0));
    expect(clock.isLive).toBe(true);
    expect(clock.serviceDate).toBe('2026-11-16');
    expect(clock.serviceSeconds).toBe(21 * 3600);
  });

  it('некорректные параметры конфигурации отвергаются', () => {
    expect(() => new SimulationClock({ stepHz: 0 })).toThrow(RangeError);
    expect(() => new SimulationClock({ stepHz: Number.NaN })).toThrow(RangeError);
    expect(() => new SimulationClock({ maxCatchUpSteps: 0 })).toThrow(RangeError);
    expect(() => new SimulationClock({ maxCatchUpSteps: 1.5 })).toThrow(RangeError);
    expect(() => new SimulationClock({ fixedDate: '16.11.2026', fixedTimeSeconds: 0 })).toThrow(
      RangeError,
    );
    expect(() => new SimulationClock({ fixedTimeSeconds: 100 })).toThrow(RangeError);
    expect(() => new SimulationClock({ fixedDate: '2026-11-16', fixedTimeSeconds: 86400 })).toThrow(
      RangeError,
    );
    expect(() => new SimulationClock({ seed: -1 })).toThrow(RangeError);
  });
});

/** Минимальный узел: две фазы по 15 с, манёвры m0/m1 конфликтуют. */
function twoPhaseNode(): MobilitySignalNode {
  const groups: MobilitySignalNode['groups'] = [
    { id: 'g0', kind: 'vehicle', aspects: ['green', 'yellow'] },
    { id: 'g1', kind: 'vehicle', aspects: ['green', 'yellow'] },
  ];
  const movements: MobilitySignalNode['movements'] = [0, 1].map((index) => ({
    id: `m${index}`,
    kind: 'vehicle',
    approach: { edgeId: `in:m${index}`, laneIndex: 0 },
    exitEdgeId: `out:m${index}`,
    path: { p: [0, 0, 0, 20, 0, 0], s: [0, 20] },
    group: index,
    clearanceLengthM: 4,
  }));
  return {
    id: 'j:fps-determinism',
    kind: 'junction',
    x: 0,
    y: 0,
    groups,
    movements,
    stopLines: [],
    heads: [],
    program: {
      id: 'fps-v1',
      phases: [
        { green: [0], greenS: 10, yellowS: 3, allRedS: 2 },
        { green: [1], greenS: 10, yellowS: 3, allRedS: 2 },
      ],
      offsetS: 0,
    },
    conflicts: [[0, 1]],
  };
}

const ALL_DAYS_CALENDAR: MobilityServiceCalendar = {
  id: 'cal:all-days',
  startDate: '2026-11-01',
  endDate: '2026-11-30',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  timeZone: 'Europe/Minsk',
};

const FPS_TRIP: MobilityTrip = {
  id: 't:fps',
  variantId: 'r:test:0:1',
  calendarId: 'cal:all-days',
  complete: true,
  stopTimes: [
    { seq: 0, arrivalS: 28800, departureS: 28800 },
    { seq: 1, arrivalS: 29400, departureS: 29400 },
  ],
};

/** Гоняет светофор и расписание часами на заданном FPS, возвращает состояния по шагам. */
function runSimulationAtFps(fps: number): {
  steps: number;
  signalStates: string[];
  activeStates: string[];
} {
  const clock = qaClock({ seed: 11 });
  const controller = new SignalController(twoPhaseNode());
  const schedule = new TripSchedule({
    calendars: [ALL_DAYS_CALENDAR],
    trips: [FPS_TRIP],
  });
  const signalStates: string[] = [];
  const activeStates: string[] = [];
  const frameCount = Math.round(20 * fps);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const steps = clock.advance(1 / fps);
    for (let step = 0; step < steps; step += 1) {
      controller.update(clock.stepSeconds);
      signalStates.push(
        JSON.stringify({ aspects: controller.aspects(), phase: controller.phase, stage: controller.stage }),
      );
      activeStates.push(
        schedule
          .activeTrips(clock.serviceDate, clock.serviceSeconds)
          .map(
            (item) =>
              `${item.trip.id}:${item.phase.kind}:${item.phase.progress.toFixed(6)}:${item.serviceDate}:${item.serviceSeconds}`,
          )
          .join('|'),
      );
    }
  }
  return { steps: clock.stepCount, signalStates, activeStates };
}

describe('SimulationClock — интеграция: FPS не меняет состояние логики', () => {
  it('одинаковые шаги дают одинаковые фазы светофора и активные рейсы', () => {
    const sixty = runSimulationAtFps(60);
    const thirty = runSimulationAtFps(30);
    const oneFortyFour = runSimulationAtFps(144);
    expect(sixty.steps).toBe(200);
    expect(thirty.steps).toBe(200);
    expect(oneFortyFour.steps).toBe(200);
    expect(sixty.signalStates).toEqual(thirty.signalStates);
    expect(sixty.signalStates).toEqual(oneFortyFour.signalStates);
    expect(sixty.activeStates).toEqual(thirty.activeStates);
    expect(sixty.activeStates).toEqual(oneFortyFour.activeStates);
    expect(new Set(sixty.signalStates).size).toBeGreaterThan(3);
    expect(sixty.activeStates.some((state) => state.includes('t:fps'))).toBe(true);
  });
});
