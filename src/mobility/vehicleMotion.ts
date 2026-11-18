/**
 * Isometric Minsk — модель движения рейса вдоль пути варианта.
 *
 * Модуль чистой математики: здесь нет Three.js, React, таймеров и обращений к
 * часам. Он получает текущее состояние (пройденная дистанция + скорость),
 * шаг `dt` и ограничения на шаг — и возвращает новое состояние. Оркестрация
 * рейсов (расписание, светофоры, занятость) живёт в `simulation.ts`.
 *
 * Что здесь есть:
 *  - `MotionProfile` — модельные параметры скорости/ускорения/торможения,
 *    габарита и зазора по видам транспорта (это НЕ измерения города);
 *  - `advanceMotion()` — шаг профиля: разгон не выше `accelMps2`, торможение не
 *    резче `brakingMps2`, скорость не выше лимита и не выше безопасной скорости
 *    торможения до границы; граница (стоп-линия, остановка, впереди идущая
 *    машина) не пересекается даже при дискретном шаге;
 *  - `maxSpeedForStoppingDistance()` — обратная к тормозному пути величина
 *    (тормозной путь считается в `signals.ts`, логика не дублируется);
 *  - `schedulePaceSpeed()` — целевая скорость по остатку пути и времени до
 *    планового прибытия: приезжать к плановому отправлению, не гнать сверх
 *    лимита; при опоздании разрешён лимит, но не больше;
 *  - `buildRoutePath()` — путь варианта конкатенацией полос рёбер
 *    (`TripWorld.getEdge`): остановки привязываются к дистанции по паре
 *    (edgeId, s). Если геометрия рёбер ещё не загружена, возвращается явный
 *    fallback по остановкам с флагом `exact=false` и списком отсутствующих
 *    рёбер — вызывающий код обязан показать это в статусе, а не выдавать
 *    хорду за проверенный путь.
 *
 * Времена, задержки и решения по светофорам сюда не входят: модуль отвечает
 * только за физику продольного движения и геометрию пути.
 */

import { mobilityArcLengths, mobilitySample } from '../shared/mobility';
import type {
  MobilityEdge,
  MobilityMode,
  MobilityRouteFile,
  MobilityRouteVariant,
  MobilityStopCall,
} from '../shared/mobility';
import { DEFAULT_BRAKING_MPS2, DEFAULT_REACTION_S } from './signals';

/** Разумное «комфортное» ускорение по умолчанию, м/с² (модельный параметр). */
export const DEFAULT_ACCEL_MPS2 = 1.2;

/** Минимальный ходовой темп, м/с: не ползти со скоростью 0.2 м/с весь перегон. */
export const DEFAULT_MIN_CRUISE_MPS = 4;

/** Модельные параметры одного вида транспорта. */
export interface MotionProfile {
  /** Максимальная скорость, м/с (модельный параметр, не измерение). */
  maxSpeedMps: number;
  /** Разгон, м/с². */
  accelMps2: number;
  /** Сервисное торможение, м/с². */
  brakingMps2: number;
  /** Время реакции, с. */
  reactionS: number;
  /** Габарит кузова, м (для стоп-линий и очереди). */
  bodyLengthM: number;
  /** Минимальный зазор до впереди стоящей машины, м. */
  safetyGapM: number;
  /**
   * Минимальный ходовой темп, м/с. Расписание может дать очень много времени
   * на перегон; машина не ползёт, а едет с этим темпом и ждёт отправления.
   */
  minCruiseMps: number;
}

/**
 * Параметры по умолчанию, м/с и м/с².
 *
 * Это модельные параметры конкретной реализации, а не измеренные данные
 * Минска; в payload они не публикуются (см. `docs/mobility/CONTRACT.md`).
 */
export const DEFAULT_MOTION_PROFILES: Readonly<Record<MobilityMode, MotionProfile>> = Object.freeze({
  bus: {
    maxSpeedMps: 14,
    accelMps2: 1.2,
    brakingMps2: 3,
    reactionS: 0.5,
    bodyLengthM: 12,
    safetyGapM: 3,
    minCruiseMps: 4,
  },
  trolleybus: {
    maxSpeedMps: 13,
    accelMps2: 1,
    brakingMps2: 3,
    reactionS: 0.5,
    bodyLengthM: 12,
    safetyGapM: 3,
    minCruiseMps: 3.8,
  },
  tram: {
    maxSpeedMps: 13,
    accelMps2: 0.9,
    brakingMps2: 2.5,
    reactionS: 0.6,
    bodyLengthM: 15,
    safetyGapM: 5,
    minCruiseMps: 3.3,
  },
});

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} должен быть положительным конечным числом, получено: ${value}`);
  }
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} должен быть неотрицательным конечным числом, получено: ${value}`);
  }
}

/** Профиль вида транспорта с возможными переопределениями (валидируется). */
export function motionProfileForMode(
  mode: MobilityMode,
  overrides: Partial<MotionProfile> = {},
): MotionProfile {
  const base = DEFAULT_MOTION_PROFILES[mode] ?? DEFAULT_MOTION_PROFILES.bus;
  const profile: MotionProfile = { ...base, ...overrides };
  assertPositive(profile.maxSpeedMps, 'maxSpeedMps');
  assertPositive(profile.accelMps2, 'accelMps2');
  assertPositive(profile.brakingMps2, 'brakingMps2');
  assertNonNegative(profile.reactionS, 'reactionS');
  assertPositive(profile.bodyLengthM, 'bodyLengthM');
  assertNonNegative(profile.safetyGapM, 'safetyGapM');
  assertNonNegative(profile.minCruiseMps, 'minCruiseMps');
  if (profile.minCruiseMps > profile.maxSpeedMps) {
    throw new RangeError('minCruiseMps не может быть больше maxSpeedMps');
  }
  return profile;
}

/** Текущее состояние продольного движения. */
export interface MotionState {
  /** Пройденная дистанция вдоль пути, м. */
  distanceM: number;
  /** Скорость, м/с (≥ 0). */
  speedMps: number;
}

/** Ограничения одного шага. */
export interface MotionConstraint {
  /** Целевая скорость по расписанию/лимиту, м/с. */
  targetSpeedMps: number;
  /**
   * Дистанция от текущего положения до жёсткой границы, м (0 = стоим перед
   * ней, `undefined` — границы нет). Граница не пересекается.
   */
  stopDistanceM?: number;
}

/** Почему скорость на шаге оказалась меньше целевой. */
export type MotionLimit = 'none' | 'acceleration' | 'cruising' | 'schedule' | 'stopping';

/** Результат шага профиля (новое состояние, без мутации входа). */
export interface MotionStepResult extends MotionState {
  /** true, если шаг упёрся в границу и скорость обнулена. */
  atBoundary: boolean;
  /** Доминирующее ограничение шага (для QA/тестов). */
  limitedBy: MotionLimit;
}

/**
 * Наибольшая скорость, с которой ещё можно остановиться за `distanceM`.
 *
 * Решает `v·reactionS + v²/(2·brakingMps2) ≤ distanceM`. Это обратная функция к
 * `stoppingDistanceM()` из `signals.ts`; сама тормозная модель не дублируется.
 * Нечисловые/неположительные данные дают `Infinity` (ограничения нет).
 */
export function maxSpeedForStoppingDistance(
  distanceM: number,
  brakingMps2 = DEFAULT_BRAKING_MPS2,
  reactionS = DEFAULT_REACTION_S,
): number {
  if (!Number.isFinite(distanceM) || !Number.isFinite(brakingMps2) || !Number.isFinite(reactionS)) {
    return Number.POSITIVE_INFINITY;
  }
  if (brakingMps2 <= 0) return Number.POSITIVE_INFINITY;
  if (distanceM <= 0) return 0;
  const reaction = Math.max(0, reactionS);
  const braking = brakingMps2;
  const root = Math.sqrt((braking * reaction) ** 2 + 2 * braking * distanceM);
  return Math.max(0, root - braking * reaction);
}

/**
 * Целевая скорость перегона.
 *
 * `remainingDistanceM / timeLeftS` — средний темп, при котором машина придёт
 * к плановому времени; ограничен сверху лимитом вида транспорта. Когда времени
 * уже нет (опоздание), разрешён лимит — но не больше лимита, «догонять»
 * расписание ускорением сверх модели запрещено. Минимальный ходовой темп не даёт
 * ползти весь перегон: в этом случае машина приедет раньше и подождёт отправления
 * (ожидание решает оркестратор).
 */
export function schedulePaceSpeed(
  remainingDistanceM: number,
  timeLeftS: number,
  maxSpeedMps: number,
  minCruiseMps = DEFAULT_MIN_CRUISE_MPS,
): number {
  if (!Number.isFinite(remainingDistanceM) || remainingDistanceM <= 0) return 0;
  const maxSpeed = Number.isFinite(maxSpeedMps) && maxSpeedMps > 0 ? maxSpeedMps : 0;
  const minCruise = Number.isFinite(minCruiseMps) ? Math.max(0, Math.min(minCruiseMps, maxSpeed)) : 0;
  if (!Number.isFinite(timeLeftS) || timeLeftS <= 0) return maxSpeed;
  const pace = remainingDistanceM / timeLeftS;
  if (!Number.isFinite(pace)) return maxSpeed;
  return Math.min(maxSpeed, Math.max(minCruise, pace));
}

/**
 * Один шаг продольного профиля.
 *
 * Гарантии:
 *  - `0 ≤ speedMps ≤ profile.maxSpeedMps`;
 *  - разгон не больше `accelMps2·dt`, торможение не резче `brakingMps2·dt`;
 *  - при конечной `stopDistanceM` граница не пересекается: если расчётный шаг
 *    её достигает, дистанция обрезается по границе, скорость обнуляется
 *    (`atBoundary`), телепорта за границу нет;
 *  - нечисловой/отрицательный `dt` — ошибка вызывающего кода.
 */
export function advanceMotion(
  state: MotionState,
  dtSeconds: number,
  profile: MotionProfile,
  constraint: MotionConstraint,
): MotionStepResult {
  if (!Number.isFinite(dtSeconds) || dtSeconds < 0) {
    throw new RangeError(`Шаг движения должен быть неотрицательным конечным числом, получено: ${dtSeconds}`);
  }
  const maxSpeed = profile.maxSpeedMps;
  const speed0 = Number.isFinite(state.speedMps) ? Math.min(Math.max(0, state.speedMps), maxSpeed) : 0;
  const distance0 = Number.isFinite(state.distanceM) ? Math.max(0, state.distanceM) : 0;
  if (dtSeconds === 0) {
    return { distanceM: distance0, speedMps: speed0, atBoundary: false, limitedBy: 'none' };
  }

  const rawStopDistance = constraint.stopDistanceM;
  const hasBoundary = rawStopDistance !== undefined && Number.isFinite(rawStopDistance);
  const stopDistance = hasBoundary ? Math.max(0, rawStopDistance) : Number.POSITIVE_INFINITY;
  const speedForBoundary = hasBoundary
    ? maxSpeedForStoppingDistance(stopDistance, profile.brakingMps2, profile.reactionS)
    : Number.POSITIVE_INFINITY;
  const scheduleTarget = Number.isFinite(constraint.targetSpeedMps)
    ? Math.max(0, constraint.targetSpeedMps)
    : maxSpeed;
  const target = Math.min(maxSpeed, scheduleTarget, speedForBoundary);
  const targetIsBoundary =
    hasBoundary && speedForBoundary <= scheduleTarget + 1e-9 && speedForBoundary <= maxSpeed + 1e-9;
  const targetIsSchedule = !targetIsBoundary && target < maxSpeed - 1e-9;

  let speed: number;
  if (target > speed0) {
    speed = Math.min(target, speed0 + profile.accelMps2 * dtSeconds);
  } else {
    speed = Math.max(target, speed0 - profile.brakingMps2 * dtSeconds);
  }
  speed = Math.max(0, Math.min(speed, maxSpeed));

  let travelled = ((speed0 + speed) / 2) * dtSeconds;
  let atBoundary = false;
  if (hasBoundary && travelled >= stopDistance - 1e-9) {
    // Не пересекаем границу даже на один дискретный шаг.
    travelled = stopDistance;
    speed = 0;
    atBoundary = true;
  } else if (hasBoundary && stopDistance <= 1e-9) {
    travelled = 0;
    speed = 0;
    atBoundary = true;
  }

  let limitedBy: MotionLimit = 'none';
  if (atBoundary) limitedBy = 'stopping';
  else if (speed < speed0 - 1e-9) limitedBy = 'cruising';
  else if (targetIsBoundary) limitedBy = 'stopping';
  else if (targetIsSchedule) limitedBy = 'schedule';
  else if (speed < target - 1e-9) limitedBy = 'acceleration';
  else if (speed < maxSpeed - 1e-9) limitedBy = 'cruising';

  return {
    distanceM: distance0 + Math.max(0, travelled),
    speedMps: speed,
    atBoundary,
    limitedBy,
  };
}

/* ------------------------------------------------------------------------- */
/* Путь варианта.                                                            */
/* ------------------------------------------------------------------------- */

/** Расстояние между соседними остановками, ниже которого точки сливаются, м. */
const MERGE_DISTANCE_M = 0.25;

/** Стыковые вершины соседних полос с таким расхождением считаются одной точкой, м. */
const JUNCTION_EPSILON_M = 0.05;

/** Допуск бокового отклонения при проекции остановки на путь, м. */
const STOP_LATERAL_TOLERANCE_M = 2.5;

/**
 * Боковой запас от внешней кромки проезжей части, м.
 *
 * Полоса из payload рассчитана по `lanes`/`width` OSM, а покрытие в тайлах
 * рисуется по своим штрихам и настилам мостов: у кромки они расходятся на
 * 0,5–1 м. Крайняя правая полоса поэтому упирается в бордюр, и кузов (2,5 м)
 * свешивается с асфальта — визуально «едет не по дороге». Сдвигаем центр
 * полосы внутрь на этот запас; привязка остановок и их `s` не меняются,
 * меняется только поперечная позиция кузова.
 */
export const LANE_INWARD_BIAS_M = 0.6;

/**
 * Смещает путь влево (к осевой дороги) на `biasM * weight[i]`.
 *
 * Сдвиг полосы каждого ребра по отдельности ломает сшивку в узлах: концы
 * соседних полос расходятся, и путь получает лишние «мостики» длиной до
 * метра. Поэтому сдвигаем уже собранную непрерывную линию — дистанции
 * (`arc`) остаются прежними, меняется только поперечная позиция кузова.
 * Вес 0 у полос без смещения (узкая односторонняя улица): там кузов и так
 * стоит по центру, и сдвиг только вынес бы его на встречную кромку.
 */
function shiftPathLeft(
  points: number[],
  weights: readonly number[],
  biasM: number = LANE_INWARD_BIAS_M,
): number[] {
  const count = Math.floor(points.length / 3);
  if (!(biasM > 0) || count < 2) return points;
  const normals: { x: number; y: number }[] = [];
  for (let index = 1; index < count; index += 1) {
    const dx = points[index * 3] - points[index * 3 - 3];
    const dy = points[index * 3 + 1] - points[index * 3 - 2];
    const length = Math.hypot(dx, dy);
    normals.push(length > 1e-9 ? { x: -dy / length, y: dx / length } : { x: 0, y: 0 });
  }
  const result = points.slice();
  for (let index = 0; index < count; index += 1) {
    const shift = biasM * (weights[index] ?? 0);
    if (Math.abs(shift) < 1e-9) continue;
    const before = normals[Math.max(0, index - 1)] ?? normals[0];
    const after = normals[Math.min(normals.length - 1, index)] ?? before;
    let nx = before.x + after.x;
    let ny = before.y + after.y;
    const length = Math.hypot(nx, ny);
    if (length <= 1e-9) {
      nx = before.x;
      ny = before.y;
      if (Math.hypot(nx, ny) <= 1e-9) continue;
    } else {
      nx /= length;
      ny /= length;
    }
    result[index * 3] += nx * shift;
    result[index * 3 + 1] += ny * shift;
  }
  return result;
}

/**
 * Проекция точки на полилинию пути в пределах диапазона `[minS, maxS]`.
 * Возвращает расстояние вдоль пути и боковое отклонение; `null` — проекция
 * не нашлась. Небольшой запас за границами нужен потому, что сшивка полосы
 * в узле смещает вершины на несколько метров.
 */
function projectOntoPath(
  points: readonly number[],
  arc: readonly number[],
  x: number,
  y: number,
  minS: number,
  maxS: number,
): { distanceM: number; lateralM: number } | null {
  const count = Math.floor(points.length / 3);
  if (count < 2) return null;
  const lower = Math.min(minS, maxS) - 30;
  const upper = Math.max(minS, maxS) + 30;
  let best: { distanceM: number; lateralM: number } | null = null;
  for (let index = 1; index < count; index += 1) {
    const s0 = arc[index - 1] ?? 0;
    const s1 = arc[index] ?? s0;
    if ((s0 + s1) / 2 < lower || (s0 + s1) / 2 > upper) continue;
    const ax = points[(index - 1) * 3];
    const ay = points[(index - 1) * 3 + 1];
    const bx = points[index * 3];
    const by = points[index * 3 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-9) continue;
    const t = Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / lengthSquared, 0), 1);
    const lateralM = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
    if (best === null || lateralM < best.lateralM) {
      best = { distanceM: s0 + (s1 - s0) * t, lateralM };
    }
  }
  return best;
}

/** Источник геометрии рёбер (обычно `TripWorld.getEdge`). */
export type EdgeGeometrySource = (edgeId: string) => MobilityEdge | null;

/** Параметры пути варианта. */
export interface RoutePath {
  variantId: string;
  mode: MobilityMode;
  ref: string;
  headSign: string;
  /** Плоская полилиния `[x, y, h, …]` в порядке движения. */
  points: number[];
  /** Накопленная длина в каждой вершине, м. */
  arc: number[];
  /** Дистанция стоянки каждой остановки варианта, м (индекс = seq). */
  stopDistancesM: number[];
  /** Индекс ребра варианта, на котором стоит каждая остановка (-1 — не найдено). */
  stopEdgeIndex: number[];
  /** Порядок рёбер варианта (нужен для сопоставления сигналов с перегоном). */
  edges: readonly string[];
  /** Исходные stop calls (порядок совпадает с `stopDistancesM`). */
  stopCalls: readonly MobilityStopCall[];
  /** Полная длина пути, м. */
  lengthM: number;
  /** Направление в первой вершине (для вырожденного пути из одной точки). */
  defaultHeading: number;
  /**
   * true — путь собран из полос рёбер (`variant.lengthM` — проверка, не
   * масштаб); false — явный fallback по остановкам до загрузки геометрии.
   */
  exact: boolean;
  /** Рёбра, геометрии которых не хватило для точного пути (пусто у точного). */
  missingEdgeIds: readonly string[];
  /** Причина fallback (`null` у точного пути) — для статуса/notes. */
  fallbackReason: string | null;
}

/** Результат сборки пути; `null` — данных недостаточно даже для fallback. */
export interface RoutePathBuildResult {
  path: RoutePath;
  /** true — полосы рёбер, false — документированный fallback по остановкам. */
  exact: boolean;
  /** Отсутствующие рёбра (для повторной попытки после загрузки chunks). */
  missingEdgeIds: string[];
  /** Причина fallback или `null`. */
  reason: string | null;
}

function finiteStop(call: MobilityStopCall | undefined): boolean {
  return (
    call !== undefined &&
    Number.isFinite(call.x) &&
    Number.isFinite(call.y) &&
    Number.isFinite(call.h)
  );
}

/** Индекс ребра варианта для каждой остановки (один проход, курсор вперёд). */
function computeStopEdgeIndex(stops: readonly MobilityStopCall[], edges: readonly string[]): number[] {
  const result = new Array<number>(stops.length).fill(-1);
  let cursor = 0;
  for (let index = 0; index < stops.length; index += 1) {
    const call = stops[index];
    if (!call) continue;
    let found = -1;
    for (let edgeIndex = cursor; edgeIndex < edges.length; edgeIndex += 1) {
      if (edges[edgeIndex] === call.edgeId) {
        found = edgeIndex;
        break;
      }
    }
    if (found < 0 && cursor > 0 && edges[cursor - 1] === call.edgeId) {
      found = cursor - 1;
    }
    if (found >= 0) {
      result[index] = found;
      cursor = found;
    }
  }
  return result;
}

/**
 * Точный путь: конкатенация полос рёбер варианта.
 *
 * Для каждого ребра берётся полоса остановки, лежащей на этом ребре (иначе 0);
 * пустая полоса заменяется центральной линией ребра. Стыковые совпадающие
 * вершины склеиваются. Дистанция остановки = начало ребра + `s` остановки
 * вдоль её полосы (см. контракт `MobilityStopCall`).
 */
function buildExactPath(
  variant: MobilityRouteVariant,
  stops: readonly MobilityStopCall[],
  stopEdgeIndex: readonly number[],
  getEdge: EdgeGeometrySource,
): { path: RoutePath | null; missingEdgeIds: string[]; reason: string | null } {
  const edges = Array.isArray(variant.edges) ? variant.edges : [];
  if (edges.length === 0) {
    return { path: null, missingEdgeIds: [], reason: 'у варианта нет списка рёбер' };
  }
  const missing: string[] = [];
  // Записи по индексу ребра: геометрия или `null`, если рёбра ещё не загружены.
  // Частичный путь лучше полного fallback по хордам: видимая часть маршрута
  // остаётся на реальной полосе, а отсутствующий участок перекрывается коротким
  // мостом (обычно он вне кадра).
  const linesByEdge: ({ edgeId: string; line: number[]; arc: number[] | null; shiftWeight: number } | null)[] = [];
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    const edgeId = edges[edgeIndex];
    if (!edgeId) {
      return { path: null, missingEdgeIds: [], reason: `пустой id ребра в позиции ${edgeIndex}` };
    }
    let edge: MobilityEdge | null = null;
    try {
      edge = getEdge(edgeId);
    } catch {
      edge = null;
    }
    if (!edge) {
      missing.push(edgeId);
      linesByEdge.push(null);
      continue;
    }
    // Правка полосы движения: маршрут всегда идёт по ПРАВОЙ полосе своего
    // направления. Раньше полоса бралась из ближайшей остановки (а без неё —
    // lane 0, левая), из-за чего машина перескакивала поперёк дороги между
    // рёбрами. Крайняя правая полоса = максимальный index (0 = левая).
    const lanes = Array.isArray(edge.lanes) ? edge.lanes : [];
    const laneIndex = lanes.reduce(
      (best, lane) => (Number.isInteger(lane.index) && lane.index > best ? lane.index : best),
      0,
    );
    const lane = lanes.find((candidate) => candidate && candidate.index === laneIndex) ?? lanes[0];
    let line: number[] | null = null;
    let arc: number[] | null = null;
    // Правая полоса (offset < 0) сдвигается внутрь; осевая односторонней
    // улицы (offset = 0) остаётся на месте, иначе кузов ушёл бы на её левую
    // кромку. Трамвай идёт по колее и не сдвигается.
    let shiftWeight = 0;
    if (lane && lane.centerline && Array.isArray(lane.centerline.p) && lane.centerline.p.length >= 6) {
      line = lane.centerline.p;
      if (variant.mode !== 'tram' && Number.isFinite(lane.offset) && lane.offset < -0.05) {
        shiftWeight = 1;
      }
      const candidateArc = lane.centerline.s;
      if (Array.isArray(candidateArc) && candidateArc.length === line.length / 3) arc = candidateArc;
    } else if (edge.centerline && Array.isArray(edge.centerline.p) && edge.centerline.p.length >= 6) {
      line = edge.centerline.p;
      const candidateArc = edge.centerline.s;
      if (Array.isArray(candidateArc) && candidateArc.length === line.length / 3) arc = candidateArc;
    }
    if (!line) {
      missing.push(edgeId);
      linesByEdge.push(null);
      continue;
    }
    if (!line.every((value) => Number.isFinite(value))) {
      return { path: null, missingEdgeIds: [], reason: `ребро ${edgeId}: нечисловая геометрия` };
    }
    linesByEdge.push({ edgeId, line, arc, shiftWeight });
  }
  if (linesByEdge.every((entry) => entry === null)) {
    return {
      path: null,
      missingEdgeIds: missing,
      reason: `не загружена геометрия рёбер: ${missing.length}`,
    };
  }
  for (let stopIndex = 0; stopIndex < stops.length; stopIndex += 1) {
    if ((stopEdgeIndex[stopIndex] ?? -1) < 0) {
      const call = stops[stopIndex];
      return {
        path: null,
        missingEdgeIds: [],
        reason: `остановка ${call?.stopId ?? String(stopIndex)} не найдена на рёбрах варианта`,
      };
    }
  }

  const points: number[] = [];
  const arc: number[] = [];
  const shiftWeights: number[] = [];
  const edgeStarts = new Array<number>(edges.length).fill(0);
  const edgeLengths = new Array<number>(edges.length).fill(0);
  for (let edgeIndex = 0; edgeIndex < linesByEdge.length; edgeIndex += 1) {
    const entry = linesByEdge[edgeIndex];
    const currentEnd = points.length >= 3 ? arc[arc.length - 1] ?? 0 : 0;
    if (!entry) {
      // Ребро не загружено: диапазон остановок этого ребра будет растянут до
      // начала следующего загруженного (см. проекцию остановок ниже).
      edgeStarts[edgeIndex] = currentEnd;
      edgeLengths[edgeIndex] = 0;
      continue;
    }
    const vertexCount = Math.floor(entry.line.length / 3);
    let lineArc = entry.arc;
    if (!lineArc || lineArc.length !== vertexCount) {
      lineArc = mobilityArcLengths(entry.line);
    }
    if (!lineArc.every((value) => Number.isFinite(value)) || vertexCount < 2) {
      return { path: null, missingEdgeIds: [], reason: `ребро ${entry.edgeId}: вырожденная полоса` };
    }
    const baseS = lineArc[0] ?? 0;
    let startVertex = 0;
    let edgeStart = currentEnd;
    if (points.length >= 3) {
      const lastX = points[points.length - 3];
      const lastY = points[points.length - 2];
      const gap = Math.hypot(entry.line[0] - lastX, entry.line[1] - lastY);
      if (gap < JUNCTION_EPSILON_M) {
        // Совпадающая стыковая вершина: не дублируем точку.
        startVertex = 1;
      } else {
        // Мост через отсутствующие рёбра: одна прямая до начала загруженного.
        arc.push(currentEnd + gap);
        points.push(entry.line[0], entry.line[1], entry.line[2]);
        shiftWeights.push(entry.shiftWeight);
        edgeStart = currentEnd + gap;
        startVertex = 1;
      }
    }
    edgeStarts[edgeIndex] = edgeStart;
    for (let vertex = startVertex; vertex < vertexCount; vertex += 1) {
      const x = entry.line[vertex * 3];
      const y = entry.line[vertex * 3 + 1];
      const h = entry.line[vertex * 3 + 2];
      if (points.length >= 3) {
        const lastX = points[points.length - 3];
        const lastY = points[points.length - 2];
        if (Math.hypot(x - lastX, y - lastY) < JUNCTION_EPSILON_M) continue;
      }
      const local = (lineArc[vertex] ?? baseS) - baseS;
      arc.push(edgeStart + local);
      points.push(x, y, h);
      shiftWeights.push(entry.shiftWeight);
    }
    edgeLengths[edgeIndex] = (arc[arc.length - 1] ?? edgeStart) - edgeStart;
  }
  if (points.length < 3) {
    return { path: null, missingEdgeIds: [], reason: 'пустая геометрия полос' };
  }
  // Кузов автобуса/троллейбуса стоит на правой полосе, а её внешняя кромка в
  // тайлах обычно уже полосы OSM: колесо и часть кузова оказываются на
  // бордюре или за настилом моста. Сдвигаем непрерывный путь внутрь только на
  // участках правой полосы — трамвай и осевые улицы остаются как есть.
  const shifted = shiftPathLeft(points, shiftWeights);
  for (let index = 0; index < points.length; index += 1) {
    points[index] = shifted[index] ?? points[index];
  }

  const stopDistancesM = new Array<number>(stops.length);
  for (let stopIndex = 0; stopIndex < stops.length; stopIndex += 1) {
    const call = stops[stopIndex];
    const edgeIndex = stopEdgeIndex[stopIndex] ?? -1;
    const edgeLength = edgeLengths[edgeIndex] ?? 0;
    const edgeStart = edgeStarts[edgeIndex] ?? 0;
    const loaded = edgeLength > 1e-3;
    let rangeEnd = edgeStart + edgeLength;
    if (!loaded) {
      // Ребро не загружено: остановку кладём в диапазон до начала следующего
      // загруженного ребра (мост). Это приближение только для невидимого
      // участка; у камеры геометрия загружена и путь точный.
      rangeEnd = arc[arc.length - 1] ?? edgeStart;
      for (let next = edgeIndex + 1; next < edges.length; next += 1) {
        if ((edgeLengths[next] ?? 0) > 1e-3) {
          rangeEnd = edgeStarts[next] ?? rangeEnd;
          break;
        }
      }
      if (rangeEnd < edgeStart) rangeEnd = edgeStart;
    }
    // Центр кузова из payload проецируется на фактическую (сшитую) полосу:
    // геометрия пути в узле могла быть плавно смещена, и `s` из файла перестал
    // быть точным. `s` остаётся запасным путём, если проекция не сошлась.
    const projection = call
      ? projectOntoPath(points, arc, call.x, call.y, edgeStart, rangeEnd)
      : null;
    const lateralLimit = loaded ? STOP_LATERAL_TOLERANCE_M : Number.POSITIVE_INFINITY;
    if (projection && projection.lateralM <= lateralLimit) {
      stopDistancesM[stopIndex] = Math.min(Math.max(projection.distanceM, edgeStart), rangeEnd);
      continue;
    }
    if (!loaded) {
      // Без геометрии ребра остановку ставим в середину моста.
      stopDistancesM[stopIndex] = edgeStart + (rangeEnd - edgeStart) * 0.5;
      continue;
    }
    const along = call && Number.isFinite(call.s) ? call.s : 0;
    if (along < -1 || along > edgeLength + 1) {
      return {
        path: null,
        missingEdgeIds: [],
        reason: `остановка ${call?.stopId ?? String(stopIndex)}: s=${along} вне полосы (${edgeLength.toFixed(1)} м)`,
      };
    }
    stopDistancesM[stopIndex] = edgeStart + Math.max(0, Math.min(along, edgeLength));
  }
  for (let stopIndex = 1; stopIndex < stopDistancesM.length; stopIndex += 1) {
    if (stopDistancesM[stopIndex] < stopDistancesM[stopIndex - 1] - 0.5) {
      return {
        path: null,
        missingEdgeIds: [],
        reason: 'дистанции остановок не возрастают (нарушен порядок рёбер)',
      };
    }
  }

  const vertexCount = points.length / 3;
  const defaultHeading =
    stops[0] && Number.isFinite(stops[0].heading)
      ? stops[0].heading
      : vertexCount > 1
        ? Math.atan2(points[4] - points[1], points[3] - points[0])
        : 0;

  const path: RoutePath = {
    variantId: variant.id,
    mode: variant.mode,
    ref: variant.ref,
    headSign: variant.headSign,
    points,
    arc,
    stopDistancesM,
    stopEdgeIndex: [...stopEdgeIndex],
    edges,
    stopCalls: stops,
    lengthM: arc[arc.length - 1] ?? 0,
    defaultHeading,
    exact: missing.length === 0,
    missingEdgeIds: [...missing],
    fallbackReason:
      missing.length > 0 ? `геометрия загружена частично: ${missing.length}` : null,
  };
  return { path, missingEdgeIds: missing, reason: null };
}

/**
 * Документированный fallback по остановкам (только пока нет геометрии рёбер).
 *
 * Хорды между последовательными остановками масштабируются так, чтобы сумма
 * совпала с `variant.lengthM`; позиции точны на остановках, между ними — хорда.
 * Вызывающий код обязан выставить `exact=false` в статусе.
 */
function buildChordPath(
  variant: MobilityRouteVariant,
  stops: readonly MobilityStopCall[],
  stopEdgeIndex: number[],
  missingEdgeIds: string[],
  reason: string | null,
): RoutePath {
  const vertexPoints: number[] = [];
  const stopVertex: number[] = [];
  let previousX = Number.NaN;
  let previousY = Number.NaN;
  for (const call of stops) {
    const merge =
      vertexPoints.length > 0 &&
      Math.hypot(call.x - previousX, call.y - previousY) < MERGE_DISTANCE_M;
    if (!merge) {
      vertexPoints.push(call.x, call.y, call.h);
      previousX = call.x;
      previousY = call.y;
    }
    stopVertex.push(vertexPoints.length / 3 - 1);
  }
  const vertexCount = vertexPoints.length / 3;
  const chord = new Array<number>(Math.max(0, vertexCount - 1));
  let rawLength = 0;
  for (let index = 1; index < vertexCount; index += 1) {
    const dx = vertexPoints[index * 3] - vertexPoints[index * 3 - 3];
    const dy = vertexPoints[index * 3 + 1] - vertexPoints[index * 3 - 2];
    const length = Math.hypot(dx, dy);
    chord[index - 1] = Number.isFinite(length) ? length : 0;
    rawLength += chord[index - 1] ?? 0;
  }
  const declaredLength = variant.lengthM;
  const scale =
    Number.isFinite(declaredLength) && declaredLength > 0 && rawLength > MERGE_DISTANCE_M
      ? declaredLength / rawLength
      : 1;
  const arc = new Array<number>(vertexCount);
  arc[0] = 0;
  for (let index = 1; index < vertexCount; index += 1) {
    arc[index] = arc[index - 1] + (chord[index - 1] ?? 0) * scale;
  }
  const stopDistancesM = new Array<number>(stops.length);
  for (let index = 0; index < stops.length; index += 1) {
    stopDistancesM[index] = arc[stopVertex[index] ?? 0] ?? 0;
  }
  const first = stops[0];
  const defaultHeading =
    first && Number.isFinite(first.heading)
      ? first.heading
      : vertexCount > 1
        ? Math.atan2(vertexPoints[4] - vertexPoints[1], vertexPoints[3] - vertexPoints[0])
        : 0;
  return {
    variantId: variant.id,
    mode: variant.mode,
    ref: variant.ref,
    headSign: variant.headSign,
    points: vertexPoints,
    arc,
    stopDistancesM,
    stopEdgeIndex,
    edges: Array.isArray(variant.edges) ? variant.edges : [],
    stopCalls: stops,
    lengthM: arc[vertexCount - 1] ?? 0,
    defaultHeading,
    exact: false,
    missingEdgeIds,
    fallbackReason: reason,
  };
}

/**
 * Собирает путь варианта из полос рёбер, а при отсутствии геометрии — явный
 * fallback по остановкам (`exact=false`), чтобы статус мог сказать правду.
 *
 * Возвращает `null` на непригодных данных (нет остановок, нечисловые
 * координаты остановок) — вызывающий код обязан показать явное состояние.
 */
export function buildRoutePath(
  variant: MobilityRouteVariant,
  getEdge: EdgeGeometrySource,
): RoutePathBuildResult | null {
  if (!variant || typeof variant.id !== 'string' || variant.id.length === 0) return null;
  const stops = Array.isArray(variant.stops) ? variant.stops : [];
  if (stops.length === 0) return null;
  if (!stops.every((call) => finiteStop(call))) return null;
  const edges = Array.isArray(variant.edges) ? variant.edges : [];
  const stopEdgeIndex = computeStopEdgeIndex(stops, edges);

  const exact = buildExactPath(variant, stops, stopEdgeIndex, getEdge);
  if (exact.path) {
    // Частичный путь: загруженные участки точные, отсутствующие перекрыты
    // мостами. Признак exact=false сохраняет статус и попытки догрузки.
    return {
      path: exact.path,
      exact: exact.missingEdgeIds.length === 0,
      missingEdgeIds: [...exact.missingEdgeIds],
      reason: exact.path.fallbackReason ?? null,
    };
  }
  const fallback = buildChordPath(
    variant,
    stops,
    stopEdgeIndex,
    exact.missingEdgeIds,
    exact.reason,
  );
  return {
    path: fallback,
    exact: false,
    missingEdgeIds: [...exact.missingEdgeIds],
    reason: exact.reason,
  };
}

/** То же, что `buildRoutePath`, но из файла варианта (вариант + рейсы). */
export function buildRoutePathFromFile(
  file: MobilityRouteFile | null,
  getEdge: EdgeGeometrySource,
): RoutePathBuildResult | null {
  if (!file || !file.variant) return null;
  return buildRoutePath(file.variant, getEdge);
}

/** Точка пути в локальных метрах (x восток, y север, h высота). */
export interface RoutePathSample {
  x: number;
  y: number;
  h: number;
  /** Направление движения, радианы против часовой от +X (восток). */
  heading: number;
}

/**
 * Позиция вдоль пути на дистанции `distanceM` (обрезается по концам пути).
 *
 * Направление берётся из сегмента полилинии; на вырожденном пути из одной точки
 * используется `defaultHeading` или heading первой остановки.
 */
export function sampleRoutePath(
  path: RoutePath,
  distanceM: number,
  target: RoutePathSample = { x: 0, y: 0, h: 0, heading: 0 },
): RoutePathSample {
  if (path.points.length === 0) {
    target.x = 0;
    target.y = 0;
    target.h = 0;
    target.heading = 0;
    return target;
  }
  if (path.points.length === 3 || path.arc.length < 2) {
    target.x = path.points[0] ?? 0;
    target.y = path.points[1] ?? 0;
    target.h = path.points[2] ?? 0;
    target.heading = path.defaultHeading;
    return target;
  }
  mobilitySample(path.points, path.arc, distanceM, target);
  if (!Number.isFinite(target.heading)) target.heading = path.defaultHeading;
  return target;
}
